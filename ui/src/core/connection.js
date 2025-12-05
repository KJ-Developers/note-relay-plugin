/**
 * VaultConnection Class - Unified Transport Layer (HTTP + WebRTC)
 * Handles both local HTTP (localhost:5474) and remote WebRTC connections
 */

// Supabase credentials loaded dynamically from API (no hardcoded keys)
let supabase = null;
let supabaseCredentials = null;

async function initSupabase() {
    if (!supabase && supabaseCredentials) {
        const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
        supabase = createClient(supabaseCredentials.url, supabaseCredentials.anonKey);
    }
    return supabase;
}

/**
 * Check if WebRTC connection is using TURN relay
 */
export async function checkTurnUsed(peer) {
    if (!peer || !peer._pc) return false;
    
    try {
        const stats = await peer._pc.getStats();
        for (const stat of stats.values()) {
            if (stat.type === 'candidate-pair' && stat.state === 'succeeded') {
                const localStat = stats.get(stat.localCandidateId);
                const remoteStat = stats.get(stat.remoteCandidateId);
                
                if (localStat?.candidateType === 'relay' || remoteStat?.candidateType === 'relay') {
                    return true;
                }
            }
        }
    } catch (e) {
        console.error('Error checking TURN usage:', e);
    }
    
    return false;
}

/**
 * Log connection event to Supabase for analytics
 */
export async function logConnectionEvent(vaultId, eventType, errorMessage = null, turnUsed = false) {
    try {
        const sb = await initSupabase();
        const { data: { user } } = await sb.auth.getUser();
        if (!user) return;
        
        const response = await fetch('https://noterelay.io/api/vaults?route=log-connection', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${(await sb.auth.getSession()).data.session?.access_token}`
            },
            body: JSON.stringify({
                vaultId,
                eventType,
                errorMessage,
                turnUsed
            })
        });
        
        if (!response.ok) {
            console.warn('Failed to log connection event:', await response.text());
        }
    } catch (e) {
        console.error('Error logging connection event:', e);
    }
}

export default class VaultConnection {
    constructor() {
        this.mode = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') ? 'local' : 'remote';
        this.authHash = null;
        this.peer = null;
        this.onMessage = null;
        this.incomingChunks = { TREE: '', FILE: '' };
        this.CLIENT_ID = null;
        this.signalingChannel = null;
        this.uniqueClientId = null;
        this.password = null;
        console.log(`🔌 Note Relay: Initializing in ${this.mode.toUpperCase()} mode`);
    }

    /**
     * Hash password using SHA-256
     */
    async hashString(str) {
        const encoder = new TextEncoder();
        const data = encoder.encode(str);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    /**
     * Connect using appropriate strategy (local HTTP or remote WebRTC)
     */
    async connect(password, onStatusUpdate) {
        this.onStatusUpdate = onStatusUpdate || ((msg) => console.log(msg));
        
        if (this.mode === 'local') {
            return this.connectLocal(password);
        } else {
            return this.connectRemote(password);
        }
    }

    /**
     * Local HTTP connection strategy
     */
    async connectLocal(password) {
        this.authHash = await this.hashString(password);
        
        this.onStatusUpdate("Using Local HTTP Mode");
        
        const response = await fetch('http://localhost:5474/api/command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cmd: 'PING', authHash: this.authHash })
        });
        
        if (!response.ok) {
            throw new Error('Authentication Failed');
        }
        
        const pingResult = await response.json();
        
        // Apply Obsidian theme if provided
        if (pingResult.data.css) {
            let styleTag = document.getElementById('obsidian-theme-vars');
            if (!styleTag) {
                styleTag = document.createElement('style');
                styleTag.id = 'obsidian-theme-vars';
                document.head.appendChild(styleTag);
            }
            styleTag.textContent = pingResult.data.css;
        }
        
        console.log('📡 PING response received');
        this.onStatusUpdate("Authenticated. Fetching Data...");
        
        // Notify UI that connection is established
        if (this.onMessage) {
            this.onMessage({ type: 'CONNECTED', data: {} });
        }
        
        // Initial data load
        await this.send('GET_TREE');
        await this.send('LOAD_TAGS');
        await this.send('LOAD_GRAPH');
        
        return true;
    }

    /**
     * Remote WebRTC connection strategy
     */
    async connectRemote(password) {
        const selectedVault = sessionStorage.getItem('selectedVault');
        if (!selectedVault) {
            throw new Error('No vault selected');
        }
        
        let vaultData;
        try {
            vaultData = JSON.parse(selectedVault);
            this.CLIENT_ID = vaultData.signalId;
            console.log('🔑 Vault Signal ID (CLIENT_ID):', this.CLIENT_ID);
        } catch (error) {
            throw new Error('Invalid vault configuration');
        }
        
        this.password = password;
        this.onStatusUpdate("Initializing connection...");
        
        // Get Supabase credentials and ICE servers from API
        // This fetches credentials dynamically (no hardcoded keys)
        try {
            const initResponse = await fetch('https://noterelay.io/api/plugin-init', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    email: vaultData.userEmail || window.userEmail, // From plugin settings
                    vaultId: vaultData.id
                })
            });

            if (!initResponse.ok) {
                const error = await initResponse.json();
                throw new Error(error.error || 'Failed to initialize connection');
            }

            const initData = await initResponse.json();
            supabaseCredentials = initData.supabase;
            this.iceServers = initData.iceServers;
            
            console.log('✅ Connection credentials obtained');
        } catch (err) {
            this.onStatusUpdate("Unable to reach connection service. Check internet connection.");
            throw err;
        }
        
        this.onStatusUpdate("Establishing secure end-to-end encryption...");
        
        // Phase 1: Try STUN-only (Direct P2P - Free)
        try {
            await this.attemptConnection(false);
        } catch (err) {
            console.log("Direct P2P connection timeout:", err.message);
        }
        
        // Phase 2: Fallback to TURN if not connected
        if (!this.peer || !this.peer.connected) {
            this.onStatusUpdate("Strict firewall detected. Switching to secure relay mode...");
            await new Promise(r => setTimeout(r, 1500));
            
            this.onStatusUpdate("Routing through secure private tunnel...");
            
            try {
                await this.attemptConnection(true);
            } catch (finalErr) {
                this.onStatusUpdate("Connection failed. Is the vault online?");
                throw finalErr;
            }
        }
        
        return true;
    }

    /**
     * Attempt WebRTC connection with given ICE configuration
     */
    async attemptConnection(useTurn) {
        return new Promise(async (resolve, reject) => {
            if (this.peer) {
                this.peer.destroy();
                this.peer = null;
            }
            
            // Use ICE servers from plugin-init API
            let iceServers = this.iceServers || [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ];
            
            // Filter based on connection phase
            if (!useTurn) {
                // Phase 1: STUN only (filter out TURN servers)
                iceServers = iceServers.filter(server => 
                    server.urls.includes('stun:')
                );
            }
            // Phase 2: Use all servers (STUN + TURN)
            
            await this.initPeer(this.password, iceServers, useTurn, resolve, reject);
        });
    }

    /**
     * Initialize SimplePeer WebRTC connection
     */
    async initPeer(password, iceServers, useTurn, resolve, reject) {
        // Load SimplePeer library dynamically
        if (typeof window.SimplePeer === 'undefined') {
            await new Promise((res, rej) => {
                const script = document.createElement('script');
                script.src = 'https://unpkg.com/simple-peer@9.11.1/simplepeer.min.js';
                script.onload = res;
                script.onerror = rej;
                document.head.appendChild(script);
            });
        }
        
        if (typeof window.SimplePeer === 'undefined') {
            reject(new Error('Failed to load peer library'));
            return;
        }
        
        // Unsubscribe from old channel
        if (this.signalingChannel) {
            await this.signalingChannel.unsubscribe();
            this.signalingChannel = null;
        }
        
        const sb = await initSupabase();
        this.uniqueClientId = 'web-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
        
        // Set up Supabase signaling channel
        this.signalingChannel = sb.channel(`portal-signaling-${Date.now()}`)
            .on('postgres_changes', { 
                event: 'INSERT', 
                schema: 'public', 
                table: 'signaling', 
                filter: `target=eq.${this.uniqueClientId}` 
            }, (payload) => {
                console.log('📥 Received signaling message:', payload.new.type);
                if (payload.new.type === 'answer' && this.peer) {
                    this.peer.signal(payload.new.payload);
                }
            })
            .subscribe();
        
        // Create peer
        this.peer = new window.SimplePeer({ 
            initiator: true, 
            trickle: false,
            config: { iceServers }
        });
        
        const timeoutDuration = useTurn ? 15000 : 5000;
        const connectionTimeout = setTimeout(async () => {
            if (this.peer && !this.peer.connected) {
                this.peer.destroy();
                reject(new Error('Connection timeout'));
            }
        }, timeoutDuration);
        
        this.peer.on('signal', async (data) => {
            console.log('📤 Sending offer to signal ID:', this.CLIENT_ID);
            
            const authHash = await this.hashString(password);
            
            await sb.from('signaling').insert({
                signal_id: this.CLIENT_ID,
                type: 'offer',
                payload: data,
                target: this.CLIENT_ID,
                client_id: this.uniqueClientId,
                auth_hash: authHash
            });
        });
        
        this.peer.on('connect', async () => {
            clearTimeout(connectionTimeout);
            console.log('✅ WebRTC connection established');
            
            // Log successful connection
            await logConnectionEvent(
                this.CLIENT_ID,
                'connected',
                null,
                await checkTurnUsed(this.peer)
            );
            
            resolve(true);
        });
        
        this.peer.on('data', (rawData) => {
            const text = new TextDecoder().decode(rawData);
            
            // Handle chunked responses
            if (text.startsWith('CHUNK_TREE:')) {
                this.incomingChunks.TREE += text.replace('CHUNK_TREE:', '');
                return;
            }
            if (text === 'END_TREE') {
                const finalData = JSON.parse(this.incomingChunks.TREE);
                this.incomingChunks.TREE = '';
                if (this.onMessage) this.onMessage(finalData);
                return;
            }
            
            if (text.startsWith('CHUNK_FILE:')) {
                this.incomingChunks.FILE += text.replace('CHUNK_FILE:', '');
                return;
            }
            if (text === 'END_FILE') {
                const finalData = JSON.parse(this.incomingChunks.FILE);
                this.incomingChunks.FILE = '';
                if (this.onMessage) this.onMessage(finalData);
                return;
            }
            
            try {
                const data = JSON.parse(text);
                if (this.onMessage) this.onMessage(data);
            } catch (err) {
                console.error('Failed to parse message:', err);
            }
        });
        
        this.peer.on('error', (err) => {
            console.error('Peer error:', err);
            reject(err);
        });
        
        this.peer.on('close', () => {
            console.log('WebRTC connection closed');
        });
    }

    /**
     * Send command to vault (HTTP or WebRTC)
     */
    async send(cmd, extraData = {}) {
        if (this.mode === 'local') {
            return this.sendHTTP(cmd, extraData);
        } else {
            return this.sendWebRTC(cmd, extraData);
        }
    }

    /**
     * Send command via HTTP
     */
    async sendHTTP(cmd, extraData = {}) {
        const response = await fetch('http://localhost:5474/api/command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cmd, authHash: this.authHash, ...extraData })
        });
        
        if (!response.ok) {
            throw new Error(`HTTP request failed: ${response.status}`);
        }
        
        const result = await response.json();
        
        // Trigger onMessage handler with the response (mimics WebRTC behavior)
        if (this.onMessage && result) {
            this.onMessage(result);
        }
        
        return result;
    }

    /**
     * Send command via WebRTC
     */
    sendWebRTC(cmd, extraData = {}) {
        return new Promise((resolve, reject) => {
            if (!this.peer || !this.peer.connected) {
                reject(new Error('Not connected'));
                return;
            }
            
            const message = JSON.stringify({ cmd, ...extraData });
            this.peer.send(message);
            
            const handler = (data) => {
                if (data.cmd === cmd || data.type === cmd) {
                    this.onMessage = null;
                    resolve(data);
                }
            };
            
            this.onMessage = handler;
            
            setTimeout(() => {
                if (this.onMessage === handler) {
                    this.onMessage = null;
                    reject(new Error('Request timeout'));
                }
            }, 10000);
        });
    }
}
