import { Buffer } from 'buffer';
if (typeof window !== 'undefined') {
    window.Buffer = Buffer;
}

const obsidian = require('obsidian');
const { createClient } = require('@supabase/supabase-js');
const SimplePeer = require('simple-peer');
const express = require('express');
const cors = require('cors');
const { readFileSync } = require('fs');
const { join } = require('path');

// Analytics telemetry service
import telemetryService from './telemetry';

const SUPABASE_URL = 'https://upstfmjkzrrshiprdoie.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVwc3RmbWprenJyc2hpcHJkb2llIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM4NDUxNDIsImV4cCI6MjA3OTQyMTE0Mn0.rJCvxQomRogp-9i9Uo2pK-mXpIjn0oyISivYGAifZ4s';
const API_BASE_URL = 'https://noterelay.io';
const BUILD_VERSION = 'v7.1.0-EMAIL-AUTH';
const CHUNK_SIZE = 16 * 1024;
const DEFAULT_SETTINGS = { 
  passwordHash: '',
  localPort: 5474,
  autoStartServer: true,
  // SECURITY: CORS Settings
  corsRestricted: true, // Secure by default
  corsAllowedOrigins: '', // Custom domains only (e.g. https://my-proxy.com)
  // IDENTITY-BASED REMOTE ACCESS
  userEmail: '', // User's email address (subscription validation)
  masterPasswordHash: '', // Owner's override password
  vaultId: '', // Unique vault identifier (auto-generated)
  guestList: [], // [{ userId, email, passHash, mode: 'rw'|'ro', label, status: 'pending'|'verified' }]
  // ANALYTICS
  enableAnalytics: true // Share anonymous usage statistics
};

async function hashString(str) {
  const msgBuffer = new TextEncoder().encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

class MicroServer extends obsidian.Plugin {
  async onload() {
    await this.loadSettings();
    this.addSettingTab(new MicroServerSettingTab(this.app, this));
    
    // Generate pluginId from vault path for license validation
    const vaultPath = this.app.vault.adapter.basePath;
    this.pluginId = await hashString(vaultPath);
    
    // Generate vaultId if missing (for identity-based system)
    if (!this.settings.vaultId) {
      this.settings.vaultId = crypto.randomUUID();
      await this.saveSettings();
      console.log('Generated new vaultId:', this.settings.vaultId);
    }
    console.log('Plugin ID:', this.pluginId);
    
    // TRINITY PROTOCOL: Generate Machine ID (Node ID)
    // This stays local (localStorage) and does NOT sync via Obsidian Sync
    // Purpose: Distinguish different devices running the same vault
    let nodeId = window.localStorage.getItem('note-relay-node-id');
    if (!nodeId) {
      nodeId = crypto.randomUUID();
      window.localStorage.setItem('note-relay-node-id', nodeId);
      console.log('Generated new Machine ID (Node ID):', nodeId);
    }
    this.nodeId = nodeId;
    console.log('Machine Identity:', this.nodeId);
    
    // Cleanup legacy identity artifacts from removed standby feature
    window.localStorage.removeItem('portal-device-id');
    if (this.settings.targetHostId !== undefined) {
      delete this.settings.targetHostId;
      await this.saveSettings();
    }
    
    // Initialize telemetry service
    // STRICT GATING: Only enable analytics for registered users (dbVaultId present)
    // No registration = No telemetry (no local UUID usage)
    if (this.settings.enableAnalytics && this.settings.dbVaultId) {
      telemetryService.init(this.settings.dbVaultId, true);
      telemetryService.recordSessionStart('lan'); // Initial session on plugin load
      console.log('[Telemetry] Initialized for registered vault:', this.settings.dbVaultId);
    } else if (!this.settings.dbVaultId) {
      console.log('[Telemetry] Disabled - vault not registered');
    }
    
    console.log(`%c PORTAL ${BUILD_VERSION} READY`, 'color: #00ff00; font-weight: bold; background: #000;');
    this.statusBar = this.addStatusBarItem();
    this.serverRunning = false;
    
    // Auto-start server if enabled in settings (default true)
    if (this.settings.autoStartServer !== false) {
      this.startServer();
    } else {
      this.statusBar.setText('Portal: Stopped');
    }
    
    // Initialize heartbeat timestamp
    this.lastHeartbeatTime = Date.now();
    
    // Register wake detection
    this.wakeHandler = async () => {
      if (!document.hidden && this.settings.remoteLicenseKey) {
        await this.checkConnectionHealth();
      }
    };
    
    this.registerDomEvent(document, 'visibilitychange', this.wakeHandler);
    console.log('Note Relay: Wake detection enabled');
    
    setTimeout(() => this.connectSignaling(), 1000);
  }

  startServer() {
    if (this.serverRunning) {
      new obsidian.Notice('Server is already running');
      return;
    }
    
    this.statusBar.setText('Portal: Starting...');
    this.initExpressServer();
    this.serverRunning = true;
  }
  
  stopServer() {
    if (!this.serverRunning) {
      new obsidian.Notice('Server is not running');
      return;
    }
    
    if (this.expressServer) {
      this.expressServer.close(() => {
        console.log('Express server stopped');
        new obsidian.Notice('Web server stopped');
      });
      this.expressServer = null;
      this.serverRunning = false;
      this.statusBar.setText('Portal: Stopped');
      this.statusBar.style.color = '';
    }
  }

  initExpressServer() {
    this.expressApp = express();
    
    // SECURITY: Configure CORS
    if (this.settings.corsRestricted) {
      // Parse the allowed origins string into an array
      const allowedList = this.settings.corsAllowedOrigins
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0);

      this.expressApp.use(cors({
        origin: function (origin, callback) {
          // Allow requests with no origin (Postman, Electron internal, curl)
          if (!origin) return callback(null, true);

          // 1. Allow Localhost (Any Port)
          // This allows http://localhost:5474, http://localhost:3000, http://127.0.0.1:8080
          if (origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) {
             return callback(null, true);
          }

          // 2. Allow Obsidian Internal (Electron)
          // This allows the plugin to talk to itself if needed
          if (origin === 'app://obsidian.md') {
            return callback(null, true);
          }

          // 3. Check against User's Custom Allowlist
          // Only necessary if they use a custom SSL reverse proxy
          if (allowedList.includes(origin)) {
            return callback(null, true);
          }

          console.warn(`[Security] Blocked CORS request from: ${origin}`);
          callback(new Error('Not allowed by CORS'));
        }
      }));
    } else {
      // User explicitly disabled security (Risk accepted)
      console.warn('[Security] CORS restrictions are DISABLED. All origins allowed.');
      this.expressApp.use(cors());
    }
    
    // Parse JSON bodies
    this.expressApp.use(express.json({ limit: '50mb' }));
    
    // Serve client.html
    this.expressApp.get('/', (req, res) => {
      console.log('🌐 Browser connected to local interface');
      
      try {
        const { join: joinPath } = require('path');
        const { existsSync, readFileSync } = require('fs');
        
        // Correct path resolution using vault adapter
        const clientPath = joinPath(
          this.app.vault.adapter.basePath,
          this.manifest.dir,
          'client.html'
        );
        
        console.log('📂 Looking for client.html at:', clientPath);
        
        if (existsSync(clientPath)) {
          const htmlContent = readFileSync(clientPath, 'utf-8');
          res.setHeader('Content-Type', 'text/html');
          res.send(htmlContent);
          console.log('✅ Served client.html successfully');
        } else {
          const errorMsg = `Error: client.html not found at ${clientPath}`;
          console.error('❌', errorMsg);
          res.status(404).send(errorMsg);
        }
      } catch (error) {
        console.error('❌ Error serving client.html:', error);
        res.status(500).send('Error loading client interface: ' + error.message);
      }
    });

    // V2 Route: Modular Bundle with Identity Injection
    this.expressApp.get('/v2', (req, res) => {
      console.log('🌐 Browser connected to V2 interface');
      
      try {
        // Build identity payload
        const identityPayload = {
          email: this.settings.userEmail || null,
          vaultId: this.settings.vaultId,
          licenseType: this.settings.remoteLicenseKey ? 'pro' : 'free',
          token: null
        };
        
        // Extract theme CSS for user's current theme
        const themeCSS = this.extractThemeCSS();
        
        // Send HTML template with identity + theme injection + full DOM structure
        const html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Note Relay V2</title>
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📡</text></svg>">
    <link rel="stylesheet" href="/style.css">
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css" rel="stylesheet">
    <link href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css" rel="stylesheet">
    <style id="obsidian-theme-vars">${themeCSS}</style>
  </head>
  <body>
    <div id="context-menu" class="context-menu"></div>

    <div id="connect-overlay">
        <h1 style="margin-bottom: 20px; color: #dcddde; font-weight: 600;">Note Relay</h1>
        <input type="password" id="password-input" placeholder="Enter Vault Password">
        <button id="connect-btn">Unlock Vault</button>
        <div id="status-text">v12.9 - Modular Bundle</div>
    </div>

    <div id="app-container">
    <div id="sidebar">
        <div class="brand-header">
            <i class="fa-solid fa-satellite-dish"></i> Note Relay
        </div>

        <div id="sidebar-split">
            <div id="app-ribbon">
                <div class="ribbon-top">
                    <button class="ribbon-btn" onclick="openDailyNote()" title="Open today's daily note">
                        <i class="fa-solid fa-calendar-check"></i>
                    </button>
                    <button class="ribbon-btn" onclick="openGraph()" title="Open graph view">
                        <i class="fa-solid fa-share-nodes"></i>
                    </button>
                </div>
                <div class="ribbon-bottom">
                    <button class="ribbon-btn" onclick="openSettings()" title="Settings">
                        <i class="fa-solid fa-gear"></i>
                    </button>
                </div>
            </div>

            <div id="sidebar-tree-area">
                <div class="explorer-toolbar">
                    <button class="nav-btn" onclick="createNote()" title="New note">
                        <i class="fa-regular fa-file-lines"></i>
                        <i class="fa-solid fa-plus tiny-badge"></i>
                    </button>
                    <button class="nav-btn" onclick="createFolder()" title="New folder">
                        <i class="fa-regular fa-folder"></i>
                        <i class="fa-solid fa-plus tiny-badge"></i>
                    </button>
                    <button class="nav-btn" onclick="sortFiles()" title="Change sort order">
                        <i class="fa-solid fa-arrow-down-a-z"></i>
                    </button>
                    <button class="nav-btn" onclick="collapseAll()" title="Collapse all">
                        <i class="fa-solid fa-compress"></i>
                    </button>
                    <div class="spacer"></div>
                </div>

                <div class="tab-bar-container">
                    <div class="tab-bar">
                        <div id="tab-folders" class="tab active" onclick="switchTab('folders')">FOLDERS</div>
                        <div id="tab-tags" class="tab" onclick="switchTab('tags')">TAGS</div>
                    </div>
                </div>

                <div id="file-tree">Loading...</div>
            </div>
        </div>
        <div class="resize-handle" id="sidebar-resize"></div>
    </div>
        <div id="pane-notes">
            <div class="pane-header">NOTES</div>
            <div class="search-box-container"><input id="search-input" placeholder="Filter notes..." onkeyup="doSearch(event)"></div>
            <div id="note-list"></div>
        </div>
        <div id="pane-editor">
            <div id="editor-header">
                <span id="filename" style="font-weight:700; color:var(--text-normal);">Select a note...</span>
                <div style="display:flex; align-items:center;">
                    <button id="focus-btn" class="header-btn" title="Toggle Focus Mode" onclick="toggleFocus()"><i class="fa-solid fa-maximize"></i></button>
                    <button id="view-btn" class="header-btn" title="Toggle Reading/Editing" onclick="toggleViewMode()"><i class="fa-regular fa-eye"></i></button>
                    <button id="save-btn" class="save-btn" onclick="saveFile()">Save</button>
                </div>
            </div>
            
            <div id="editor-wrapper">
                <textarea id="editor"></textarea>
                <div id="preview-loading">
                    <div class="spinner"></div>
                    <div>Rendering High-Fidelity View...</div>
                </div>
                <div id="yaml-properties-container" class="yaml-properties-container" style="display: none;"></div>
                <div id="custom-preview"></div>
            </div>

            <div id="context-panel">
                <div id="local-graph-container">
                    <div class="context-header" onclick="togglePanel('graph')">LOCAL GRAPH <i id="icon-graph" class="fa-solid fa-chevron-down"></i></div>
                    <div id="graph-canvas"></div>
                </div>
                <div id="backlinks-container">
                    <div class="context-header" onclick="togglePanel('backlinks')">BACKLINKS <i id="icon-backlinks" class="fa-solid fa-chevron-down"></i></div>
                    <div id="backlinks-list"></div>
                </div>
            </div>
        </div>
    </div>
    
    <script>
      window.NOTE_RELAY_IDENTITY = ${JSON.stringify(identityPayload)};
      console.log('✅ Note Relay V2 Identity Injected:', window.NOTE_RELAY_IDENTITY);
    </script>
    
    <script src="/ui-bundle.js"></script>
  </body>
</html>`;
        
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
        console.log('✅ Served V2 bundle interface successfully');
      } catch (error) {
        console.error('❌ Error serving V2 interface:', error);
        res.status(500).send('Error loading V2 interface: ' + error.message);
      }
    });

    // Serve ui-bundle.js
    this.expressApp.get('/ui-bundle.js', (req, res) => {
      try {
        const { join: joinPath } = require('path');
        const { existsSync, readFileSync } = require('fs');
        
        const bundlePath = joinPath(
          this.app.vault.adapter.basePath,
          this.manifest.dir,
          'ui-bundle.js'
        );
        
        console.log('📦 Serving ui-bundle.js from:', bundlePath);
        
        if (existsSync(bundlePath)) {
          const bundleContent = readFileSync(bundlePath, 'utf-8');
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
          res.send(bundleContent);
          console.log('✅ Served ui-bundle.js (', Math.round(bundleContent.length / 1024), 'KB)');
        } else {
          console.error('❌ ui-bundle.js not found at:', bundlePath);
          res.status(404).send('Bundle not found');
        }
      } catch (error) {
        console.error('❌ Error serving ui-bundle.js:', error);
        res.status(500).send('Error loading bundle: ' + error.message);
      }
    });

    // Serve style.css
    this.expressApp.get('/style.css', (req, res) => {
      try {
        const { join: joinPath } = require('path');
        const { existsSync, readFileSync } = require('fs');
        
        const cssPath = joinPath(
          this.app.vault.adapter.basePath,
          this.manifest.dir,
          'style.css'
        );
        
        console.log('📦 Serving style.css from:', cssPath);
        
        if (existsSync(cssPath)) {
          const cssContent = readFileSync(cssPath, 'utf-8');
          res.setHeader('Content-Type', 'text/css; charset=utf-8');
          res.send(cssContent);
          console.log('✅ Served style.css (', Math.round(cssContent.length / 1024), 'KB)');
        } else {
          console.error('❌ style.css not found at:', cssPath);
          res.status(404).send('CSS not found');
        }
      } catch (error) {
        console.error('❌ Error serving style.css:', error);
        res.status(500).send('Error loading CSS: ' + error.message);
      }
    });

    // API endpoint for commands
    this.expressApp.post('/api/command', async (req, res) => {
      try {
        const { authHash, cmd, path, data } = req.body;
        
        console.log(`📥 HTTP Command received: ${cmd}`, path ? `(${path})` : '');
        
        // Verify authentication and determine access level
        let isReadOnly = false;
        
        if (!authHash) {
          console.log('❌ Authentication failed - no password provided');
          return res.status(401).json({ 
            type: 'ERROR', 
            message: 'INVALID PASSWORD' 
          });
        }
        
        // Check password - local HTTP is always read-write
        console.log(`🔐 Auth check - cmd: ${cmd}`);
        console.log(`🔐 passwordHash set: ${!!this.settings.passwordHash}`);
        console.log(`🔐 authHash matches passwordHash: ${authHash === this.settings.passwordHash}`);
        
        if (authHash === this.settings.passwordHash) {
          console.log('✅ Authenticated - read-write access');
          isReadOnly = false; // Local HTTP is always read-write
        }
        // Invalid password
        else {
          console.log('❌ Authentication failed - invalid password');
          return res.status(401).json({ 
            type: 'ERROR', 
            message: 'INVALID PASSWORD' 
          });
        }
        
        // Create HTTP send callback
        const httpSendCallback = (type, responseData, meta = {}) => {
          console.log(`📤 Sending response: ${type}`, meta);
          res.json({ type, data: responseData, meta });
        };
        
        // Process the command
        await this.processCommand({ cmd, path, data }, httpSendCallback);
        
      } catch (error) {
        console.error('❌ API Error:', error);
        res.status(500).json({ 
          type: 'ERROR', 
          message: error.message 
        });
      }
    });

    // Start server
    const PORT = this.settings.localPort || 5474;
    this.expressServer = this.expressApp.listen(PORT, () => {
      console.log(`%c Express server running on http://localhost:${PORT}`, 'color: #00aaff; font-weight: bold;');
      new obsidian.Notice(`Portal web interface available at http://localhost:${PORT}`);
    });

    this.expressServer.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use`);
        new obsidian.Notice(`Port ${PORT} is already in use. Please close other instances.`);
      } else {
        console.error('Express server error:', error);
      }
    });
  }

  onunload() {
    this.disconnectSignaling();
    
    // Flush telemetry before shutdown
    if (this.settings.enableAnalytics) {
      telemetryService.recordSessionEnd();
      telemetryService.flush();
    }
    
    // Close Express server
    if (this.expressServer) {
      this.expressServer.close(() => {
        console.log('Express server closed');
      });
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
  
  /**
   * Sanitize file paths to prevent directory traversal attacks
   * @param {string} unsafePath - Raw user input path
   * @returns {string} Sanitized path safe for vault operations
   */
  sanitizePath(unsafePath) {
    if (!unsafePath || typeof unsafePath !== 'string') return '';
    
    // 1. Normalize slashes
    let clean = unsafePath.replace(/\\/g, '/');
    
    // 2. Remove path traversal attempts (..)
    clean = clean.replace(/\.\.\+/g, '');
    
    // 3. Remove leading slashes (force relative paths)
    clean = clean.replace(/^\/+/, '');
    
    // 4. Remove any remaining dangerous patterns
    clean = clean.replace(/[\/]{2,}/g, '/'); // Multiple slashes
    
    // 5. Trim whitespace
    clean = clean.trim();
    
    return clean;
  }

  async registerVaultAndGetSignalId() {
    if (!this.settings.userEmail) {
      console.log('No user email configured');
      return null;
    }

    try {
      const os = require('os');
      const response = await fetch('https://noterelay.io/api/vaults?route=register', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          email: this.settings.userEmail,
          vaultId: this.settings.vaultId,
          signalId: this.pluginId,
          vaultName: this.app.vault.getName(),
          hostname: os.hostname(),
          nodeId: this.nodeId,           // Machine ID (Trinity Protocol)
          machineName: os.hostname()     // User-friendly machine identifier
        })
      });

      if (!response.ok) {
        let errorMessage = `Registration failed: ${response.status}`;
        
        try {
          const errorData = await response.json();
          // Handle specific error cases
          if (response.status === 404 && errorData.error === 'Account not found') {
            errorMessage = '❌ Account not found. Please sign up at noterelay.io first.';
          } else if (response.status === 400 && errorData.error === 'Invalid email format') {
            errorMessage = '❌ Invalid email format. Please check your email address.';
          } else if (errorData.error) {
            errorMessage = `❌ ${errorData.error}`;
          }
        } catch (e) {
          // If JSON parsing fails, use text response
          const errorText = await response.text();
          console.error('Registration failed:', response.status, errorText);
        }
        
        new obsidian.Notice(errorMessage, 10000);
        return null;
      }

      const result = await response.json();

      if (result.success) {
        console.log('Vault registered! Signal ID:', result.signalId, 'DB Vault ID:', result.vaultId, 'Plan:', result.planType);
        this.signalId = result.signalId;
        
        // Capture license tier from server response
        if (result.planType) {
          this.settings.licenseTier = result.planType;  // 'free', 'monthly', 'annual'
          await this.saveSettings();
          console.log('License tier captured:', this.settings.licenseTier);
        }
        
        // Save the database vault ID for guest management
        if (result.vaultId) {
          this.settings.dbVaultId = result.vaultId;
          
          // AUTO-ENABLE: Registration unlocks analytics (The Teaser)
          this.settings.enableAnalytics = true;
          await this.saveSettings();
          
          // Start telemetry immediately with database ID
          telemetryService.init(this.settings.dbVaultId, true);
          telemetryService.recordSessionStart('lan');
          console.log('[Telemetry] Auto-enabled for registered vault:', this.settings.dbVaultId);
          new obsidian.Notice('Analytics enabled - view your stats at noterelay.io/dashboard');
        }
        
        this.startHeartbeat();
        // Fetch TURN credentials after successful registration
        await this.fetchTurnCredentials();
        return result.signalId;
      } else {
        new obsidian.Notice('Vault registration failed: ' + (result.error || 'Unknown error'));
        return null;
      }
    } catch (error) {
      console.error('Vault registration error:', error);
      new obsidian.Notice('Failed to register vault: ' + error.message);
      return null;
    }
  }

  async fetchTurnCredentials() {
    if (!this.settings.userEmail) return;
    
    try {
      console.log('Fetching TURN credentials for host...');
      const response = await fetch('https://noterelay.io/api/turn-credentials', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          email: this.settings.userEmail
        })
      });
      
      if (response.ok) {
        const data = await response.json();
        if (data.iceServers) {
          this.iceServers = data.iceServers;
          console.log('✅ Host TURN credentials obtained');
        }
      } else {
        const errorText = await response.text();
        console.warn('Failed to fetch host TURN credentials:', response.status, errorText);
        try {
            const errorJson = JSON.parse(errorText);
            if (errorJson.details) {
                 new obsidian.Notice(`TURN Auth Failed: ${errorJson.details}`);
            } else {
                 new obsidian.Notice(`TURN Auth Failed: ${response.status}`);
            }
        } catch (e) {
            new obsidian.Notice(`TURN Auth Failed: ${response.status}`);
        }
      }
    } catch (e) {
      console.error('Error fetching host TURN credentials:', e);
    }
  }

  startHeartbeat() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    
    console.log('Note Relay: Starting API Heartbeat (5m)...');
    
    // 1. Immediate Ping
    this.sendHeartbeat();

    // 2. Schedule Loop (Every 5 minutes)
    this.heartbeatInterval = setInterval(async () => {
      await this.sendHeartbeat();
    }, 300000); // 5 Minutes
  }

  async sendHeartbeat() {
    if (!this.settings.userEmail || !this.signalId) {
      return { success: false, fatal: false, reason: 'no-config' };
    }

    try {
      const response = await fetch('https://noterelay.io/api/vaults?route=heartbeat', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ 
          email: this.settings.userEmail,
          vaultId: this.settings.vaultId,
          signalId: this.signalId
        })
      });
      
      // ALWAYS update timestamp (we attempted contact)
      this.lastHeartbeatTime = Date.now();
      
      // KILL SWITCH: Stop if license is invalid
      if (response.status === 401 || response.status === 403) {
        console.warn(`Note Relay: License invalid (${response.status}). Stopping heartbeat.`);
        clearInterval(this.heartbeatInterval);
        new obsidian.Notice("Note Relay: License expired. Remote access paused.");
        return { success: false, fatal: true, reason: 'auth' };
      }

      if (!response.ok) {
        console.warn(`Note Relay: Heartbeat transient error (${response.status})`);
        return { success: false, fatal: false, reason: 'server' };
      }
      
      return { success: true, fatal: false };
      
    } catch (err) {
      // Update timestamp even on network error
      this.lastHeartbeatTime = Date.now();
      console.error('Note Relay: Heartbeat network error', err);
      return { success: false, fatal: false, reason: 'network' };
    }
  }

  disconnectSignaling() {
    console.log('Disconnecting signaling...');
    
    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    
    // Unsubscribe from Supabase
    if (this.channel) {
        this.channel.unsubscribe();
        this.channel = null;
    }
    
    if (this.supabase) {
        this.supabase.removeAllChannels();
        this.supabase = null;
    }

    this.signalId = null;
    if (this.statusBar) {
        this.statusBar.setText('Portal: Local Only');
        this.statusBar.style.color = '';
    }
    console.log('Signaling disconnected. Offline mode.');
  }

  /**
   * Unified command processor for both WebRTC and HTTP modes
   * @param {Object} msg - The command message { cmd, path, data }
   * @param {Function} sendCallback - Function to send response: (type, data, meta) => void
   */
  async processCommand(msg, sendCallback) {
    try {
      if (msg.cmd === 'PING' || msg.cmd === 'HANDSHAKE') {
        console.log('🔒 Server PING/HANDSHAKE received');
        const themeCSS = this.extractThemeCSS();
        sendCallback(msg.cmd === 'PING' ? 'PONG' : 'HANDSHAKE_ACK', { 
            version: BUILD_VERSION, 
            readOnly: false, // Will be overridden by HTTP/WebRTC handlers in their callbacks
            css: themeCSS
        });
        return;
      }
      
      if (msg.cmd === 'GET_TREE') {
        const files = this.app.vault.getMarkdownFiles().map((f) => {
          const cache = this.app.metadataCache.getFileCache(f);
          let tags = [], links = [];
          if (cache) {
            if (cache.frontmatter?.tags) {
              let ft = cache.frontmatter.tags;
              if (!Array.isArray(ft)) ft = [ft];
              ft.forEach((t) => tags.push(t.startsWith('#') ? t : '#' + t));
            }
            if (cache.tags) cache.tags.forEach((t) => tags.push(t.tag));
            if (cache.links) cache.links.forEach((l) => links.push(l.link));
          }
          return { path: f.path, tags: [...new Set(tags)], links: [...new Set(links)] };
        });
        
        // Get all folders including empty ones
        const allFolders = [];
        const getAllFolders = (folder) => {
          folder.children.forEach(child => {
            if (child.children) {
              allFolders.push(child.path);
              getAllFolders(child);
            }
          });
        };
        getAllFolders(this.app.vault.getRoot());
        
        // NEW: Send Theme CSS immediately with the file tree
        const treeCss = this.extractThemeCSS();
        sendCallback('TREE', { files, folders: allFolders, css: treeCss });
        return;
      }
      
      if (msg.cmd === 'GET_RENDERED_FILE') {
        const safePath = this.sanitizePath(msg.path);
        if (!safePath) {
          sendCallback('ERROR', { message: 'Invalid path' });
          return;
        }
        
        let file = this.app.vault.getAbstractFileByPath(safePath);
        let shouldRefreshTree = msg.refreshTree || false;
        
        // AUTO-CREATE MISSING FILE (Ghost Link Support)
        if (!file) {
          try {
            console.log('Ghost Link: Creating missing file', safePath);
            file = await this.app.vault.create(safePath, '');
            new obsidian.Notice(`Created: ${safePath}`);
            shouldRefreshTree = true; // FORCE REFRESH
          } catch (err) {
            console.error('Ghost Create Failed:', err);
            sendCallback('ERROR', { message: `Could not create '${safePath}'. Ensure folder exists.` });
            return;
          }
        }

        try {
            const content = await this.app.vault.read(file);
            
            // Extract YAML frontmatter
            let yamlData = null;
            let contentWithoutYaml = content;
            const yamlMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
            
            if (yamlMatch) {
                const yamlText = yamlMatch[1];
                try {
                    // Parse YAML to object (Obsidian's parser handles it)
                    const cache = this.app.metadataCache.getFileCache(file);
                    if (cache && cache.frontmatter) {
                        yamlData = { ...cache.frontmatter };
                        delete yamlData.position; // Remove metadata
                    }
                    contentWithoutYaml = content.slice(yamlMatch[0].length);
                } catch (err) {
                    console.warn('Invalid YAML frontmatter:', err);
                }
            }
            
            const div = document.createElement('div');
            
            // Render Markdown WITHOUT frontmatter
            await obsidian.MarkdownRenderer.render(this.app, contentWithoutYaml, div, file.path, this);
            
            // Smart Rendering: Wait for Dataview/Plugins to settle
            await this.waitForRender(div);
            
            // Extract CSS
            const themeCSS = this.extractThemeCSS();
            
            // 6. GRAPH & BACKLINKS DATA
            const graphData = { nodes: [], edges: [] };
            const currentPath = msg.path;
            const backlinks = [];
            
            // Add Central Node
            graphData.nodes.push({ id: currentPath, label: file.basename, group: 'center' });

            // A. Forward Links
            const cache = this.app.metadataCache.getFileCache(file);
            if (cache && cache.links) {
                cache.links.forEach(l => {
                    const linkPath = l.link; // Simple resolution for V1
                    if (!graphData.nodes.find(n => n.id === linkPath)) {
                        graphData.nodes.push({ id: linkPath, label: linkPath.split('/').pop().replace('.md',''), group: 'neighbor' });
                    }
                    graphData.edges.push({ from: currentPath, to: linkPath });
                });
            }

            // B. Backlinks
            const allLinks = this.app.metadataCache.resolvedLinks;
            for (const sourcePath in allLinks) {
                if (allLinks[sourcePath][currentPath]) {
                    backlinks.push(sourcePath);
                    if (!graphData.nodes.find(n => n.id === sourcePath)) {
                        graphData.nodes.push({ id: sourcePath, label: sourcePath.split('/').pop().replace('.md',''), group: 'neighbor' });
                    }
                    graphData.edges.push({ from: sourcePath, to: currentPath });
                }
            }
            
            // Process Assets (Images, PDFs, etc.)
            const assets = div.querySelectorAll('img, embed, object, iframe');
            for (const el of assets) {
                // Check for internal app:// links or relative paths
                let src = el.getAttribute('src') || el.getAttribute('data');
                
                if (src && src.startsWith('app://')) {
                    try {
                        // Attempt to find the file in the vault
                        // Strategy 1: Use the internal-embed src if available (most reliable for [[links]])
                        const container = el.closest('.internal-embed');
                        let targetFile = null;
                        
                        if (container && container.getAttribute('src')) {
                            const linktext = container.getAttribute('src');
                            targetFile = this.app.metadataCache.getFirstLinkpathDest(linktext, file.path);
                        }
                        
                        // Strategy 2: If no container, try to resolve the app:// URL to a file path
                        if (!targetFile) {
                             // This is harder because app:// paths are absolute. 
                             // We'll skip complex reverse-engineering for V1 and rely on Strategy 1.
                        }

                        if (targetFile) {
                            const arrayBuffer = await this.app.vault.readBinary(targetFile);
                            const base64 = Buffer.from(arrayBuffer).toString('base64');
                            const ext = targetFile.extension;
                            const mime = this.getMimeType(ext);
                            
                            if (el.tagName.toLowerCase() === 'img') {
                                el.src = `data:${mime};base64,${base64}`;
                                el.removeAttribute('srcset');
                            } else {
                                // For embed/object/iframe
                                const dataUri = `data:${mime};base64,${base64}`;
                                if (el.hasAttribute('src')) el.setAttribute('src', dataUri);
                                if (el.hasAttribute('data')) el.setAttribute('data', dataUri);
                            }
                        }
                    } catch (assetError) {
                        console.error('Failed to process asset:', src, assetError);
                    }
                }
            }

            // PREPARE RESPONSE
            const response = { 
              html: div.innerHTML,
              yaml: yamlData,
              css: themeCSS, 
              backlinks, 
              graph: graphData 
            };
            
            // INJECT TREE IF NEEDED
            if (shouldRefreshTree) {
              response.files = this.app.vault.getFiles().map(f => ({
                path: f.path,
                name: f.name,
                basename: f.basename,
                extension: f.extension
              }));
            }
            
            sendCallback('RENDERED_FILE', response, { path: safePath });

        } catch (renderError) {
            console.error('Render Error:', renderError);
            sendCallback('ERROR', { message: 'Rendering failed: ' + renderError.message });
        }
        return;
      }

      if (msg.cmd === 'GET_FILE') {
        const safePath = this.sanitizePath(msg.path);
        if (!safePath) {
          sendCallback('ERROR', { message: 'Invalid path' });
          return;
        }
        
        const file = this.app.vault.getAbstractFileByPath(safePath);
        if (!file) {
          sendCallback('ERROR', { message: 'File not found' });
          return;
        }
        
        // BANDWIDTH GUARD: Block video streaming
        const VIDEO_EXTS = ['mp4', 'mov', 'avi', 'mkv', 'iso', 'flv', 'webm', 'm4v'];
        if (VIDEO_EXTS.includes(file.extension.toLowerCase())) {
          console.log('🚫 Blocked video file request:', file.path);
          sendCallback('ERROR', { message: 'Media streaming is disabled. Video files cannot be accessed remotely.' });
          return;
        }
        
        const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'];
        if (IMAGE_EXTS.includes(file.extension)) {
          console.log(`Portal: Reading Image ${file.path}`);
          const arrayBuffer = await this.app.vault.readBinary(file);
          const base64 = Buffer.from(arrayBuffer).toString('base64');
          sendCallback('FILE', base64, { 
            path: msg.path, 
            isImage: true, 
            ext: file.extension 
          });
        } else {
          const content = await this.app.vault.read(file);
          const backlinks = [];
          
          if (file.extension === 'md') {
            const resolved = this.app.metadataCache.resolvedLinks;
            for (const [sourcePath, links] of Object.entries(resolved)) {
              if (links[msg.path]) backlinks.push(sourcePath);
            }
          }
          
          sendCallback('FILE', { 
            data: content, 
            backlinks 
          }, { path: msg.path });
        }
        return;
      }
      
      if (msg.cmd === 'SAVE_FILE') {
        const safePath = this.sanitizePath(msg.path);
        if (!safePath) {
          sendCallback('ERROR', { message: 'Invalid path' });
          return;
        }
        
        const file = this.app.vault.getAbstractFileByPath(safePath);
        if (!file) {
          sendCallback('ERROR', { message: 'File not found' });
          return;
        }
        
        await this.app.vault.modify(file, msg.data);
        
        // Record sync event
        if (this.settings.enableAnalytics) {
          telemetryService.recordSync(msg.data.length);
        }
        
        sendCallback('SAVED', { path: safePath });
        new obsidian.Notice(`Saved: ${safePath}`);
        return;
      }

      if (msg.cmd === 'CREATE_FILE') {
        const safePath = this.sanitizePath(msg.path);
        if (!safePath) {
          sendCallback('ERROR', { message: 'Invalid path' });
          return;
        }
        
        const file = this.app.vault.getAbstractFileByPath(safePath);
        if (file) {
          sendCallback('ERROR', { message: 'File already exists' });
          return;
        }
        await this.app.vault.create(safePath, '');
        new obsidian.Notice(`Created: ${safePath}`);
        
        // Recursively call GET_RENDERED_FILE with refreshTree flag
        await this.processCommand({ 
          cmd: 'GET_RENDERED_FILE', 
          path: safePath, 
          refreshTree: true 
        }, sendCallback);
        return;
      }

      if (msg.cmd === 'CREATE_FOLDER') {
        const safePath = this.sanitizePath(msg.path);
        if (!safePath) {
          sendCallback('ERROR', { message: 'Invalid path' });
          return;
        }
        
        const file = this.app.vault.getAbstractFileByPath(safePath);
        if (file) {
          sendCallback('ERROR', { message: 'Folder already exists' });
          return;
        }
        await this.app.vault.createFolder(safePath);
        sendCallback('SAVED', { path: safePath });
        new obsidian.Notice(`Created Folder: ${safePath}`);
        return;
      }

      if (msg.cmd === 'RENAME_FILE') {
        const safePath = this.sanitizePath(msg.path);
        const safeNewPath = this.sanitizePath(msg.data.newPath);
        if (!safePath || !safeNewPath) {
          sendCallback('ERROR', { message: 'Invalid path' });
          return;
        }
        
        const file = this.app.vault.getAbstractFileByPath(safePath);
        if (!file) {
          sendCallback('ERROR', { message: 'File not found' });
          return;
        }
        await this.app.fileManager.renameFile(file, safeNewPath);
        sendCallback('SAVED', { path: safeNewPath });
        new obsidian.Notice(`Renamed: ${safePath} to ${safeNewPath}`);
        return;
      }

      if (msg.cmd === 'DELETE_FILE') {
        const safePath = this.sanitizePath(msg.path);
        if (!safePath) {
          sendCallback('ERROR', { message: 'Invalid path' });
          return;
        }
        
        const file = this.app.vault.getAbstractFileByPath(safePath);
        if (!file) {
          sendCallback('ERROR', { message: 'File not found' });
          return;
        }
        await this.app.vault.trash(file, true);
        sendCallback('SAVED', { path: safePath });
        new obsidian.Notice(`Deleted: ${safePath}`);
        return;
      }

      if (msg.cmd === 'OPEN_FILE') {
        const safePath = this.sanitizePath(msg.path);
        
        if (!safePath) {
          sendCallback('ERROR', { message: 'Invalid path' });
          return;
        }
        
        const file = this.app.vault.getAbstractFileByPath(safePath);
        
        if (!file) {
          sendCallback('ERROR', { message: 'File not found' });
          return;
        }
        
        // Check frontmatter for plugin types
        const metadata = this.app.metadataCache.getFileCache(file);
        const frontmatter = metadata?.frontmatter || {};
        
        // Detect plugin type
        let detectedPlugin = null;
        if (frontmatter['kanban-plugin']) detectedPlugin = 'kanban';
        else if (frontmatter['dataview']) detectedPlugin = 'dataview';
        else if (frontmatter['excalidraw-plugin']) detectedPlugin = 'excalidraw';
        
        if (!detectedPlugin) {
          this.processCommand({
            cmd: 'GET_RENDERED_FILE',
            path: safePath
          }, sendCallback);
          return;
        }
        
        // Try to capture plugin view HTML from existing open leaf
        const workspace = this.app.workspace;
        let kanbanLeaf = workspace.getLeavesOfType('kanban')[0];
        
        console.log('🔍 OPEN_FILE Debug:', {
          detectedPlugin,
          hasKanbanLeaf: !!kanbanLeaf,
          allLeafTypes: workspace.getLeavesOfType('kanban').length,
          allLeaves: this.app.workspace.getLeavesOfType('markdown').map(l => l.getViewState().type)
        });
        
        if (!kanbanLeaf) {
          // Try to open the file in a new tab to create the view
          try {
            console.log('🔓 Attempting to open file in new leaf...');
            const newLeaf = workspace.getLeaf('tab');
            await newLeaf.openFile(file);
            console.log('✅ File opened, view type:', newLeaf.getViewState().type);
            
            // Check if it's now a kanban view
            if (newLeaf.getViewState().type === 'kanban') {
              kanbanLeaf = newLeaf;
              console.log('✅ Kanban view detected!');
            } else {
              console.warn('⚠️ View type is not kanban:', newLeaf.getViewState().type);
            }
          } catch (openError) {
            console.error('❌ Failed to open file:', openError);
          }
        } else {
          // Leaf exists but might not be rendering - force a refresh
          try {
            console.log('🔄 Kanban leaf exists, forcing refresh...');
            await kanbanLeaf.openFile(file);
            // Give it a moment to actually render
            await new Promise(resolve => setTimeout(resolve, 150));
          } catch (refreshError) {
            console.error('❌ Failed to refresh kanban leaf:', refreshError);
          }
        }
        
        console.log('🎯 Attempting to extract HTML, kanbanLeaf exists:', !!kanbanLeaf);
        
        // If we have a leaf, extract the rendered HTML
        if (kanbanLeaf) {
          const view = kanbanLeaf.view;
          
          console.log('🔍 View check:', {
            hasView: !!view,
            hasContainerEl: !!view?.containerEl,
            containerClasses: view?.containerEl?.className
          });
          
          if (view.containerEl) {
            // Wait for Kanban to render (it may be async)
            // Try multiple times with increasing delays
            let kanbanBoard = null;
            let attempts = 0;
            const maxAttempts = 5;
            
            while (!kanbanBoard && attempts < maxAttempts) {
              if (attempts > 0) {
                await new Promise(resolve => setTimeout(resolve, 100 * attempts)); // 100ms, 200ms, 300ms, 400ms
                console.log(`⏳ Retry ${attempts}/${maxAttempts} - waiting for Kanban DOM...`);
              }
              
              kanbanBoard = view.containerEl.querySelector('.kanban-plugin');
              attempts++;
            }
            
            console.log('🔍 Kanban board element:', {
              found: !!kanbanBoard,
              attempts: attempts,
              selector: '.kanban-plugin',
              containerHTML: view.containerEl.innerHTML.substring(0, 500)
            });
            
            if (kanbanBoard) {
              const capturedHTML = kanbanBoard.outerHTML;
              
              console.log('🎨 ========== KANBAN CAPTURE DEBUG ==========');
              console.log('📏 HTML length:', capturedHTML.length);
              console.log('📝 HTML preview (first 1000 chars):', capturedHTML.substring(0, 1000));
              console.log('📝 HTML preview (last 500 chars):', capturedHTML.substring(capturedHTML.length - 500));
              
              // Extract Kanban plugin CSS
              const kanbanCSS = this.extractPluginCSS('.kanban-plugin');
              
              console.log('🎨 CSS length:', kanbanCSS.length);
              console.log('🎨 CSS preview (first 2000 chars):', kanbanCSS.substring(0, 2000));
              console.log('🎨 CSS rule count:', (kanbanCSS.match(/\{/g) || []).length);
              
              const response = {
                renderedHTML: capturedHTML,
                pluginCSS: kanbanCSS,
                viewType: 'kanban',
                success: true
              };
              
              console.log('📦 Response object keys:', Object.keys(response));
              console.log('📦 Response.renderedHTML length:', response.renderedHTML.length);
              console.log('📦 Response.pluginCSS length:', response.pluginCSS.length);
              console.log('🎨 ========== END CAPTURE DEBUG ==========');
              
              sendCallback('OPEN_FILE', response, { path: safePath });
              
              // Close the leaf after capturing
              kanbanLeaf.detach();
              console.log('🗑️ Closed Kanban leaf');
              
              return;
            }
          }
        }
        
        // If we got here, fall back to markdown rendering
        console.warn('⚠️ Falling back to markdown rendering (no Kanban HTML captured)');
        
        // Wrapper to ensure we return OPEN_FILE type even for fallback
        const wrapperCallback = (type, data, meta) => {
            if (type === 'RENDERED_FILE') {
                sendCallback('OPEN_FILE', data, meta);
            } else {
                sendCallback(type, data, meta);
            }
        };

        this.processCommand({
          cmd: 'GET_RENDERED_FILE',
          path: safePath
        }, wrapperCallback);
        
        return;
      }

      if (msg.cmd === 'OPEN_DAILY_NOTE') {
        try {
          // Check if daily notes plugin is enabled
          const dailyNotesPlugin = this.app.internalPlugins?.plugins?.['daily-notes'];
          
          if (!dailyNotesPlugin || !dailyNotesPlugin.enabled) {
            sendCallback('ERROR', { message: 'Daily Notes plugin is not enabled in Obsidian' });
            return;
          }
          
          // Use Obsidian's command to create/open today's daily note
          // This properly processes Templater and respects all settings
          this.app.commands.executeCommandById('daily-notes');
          
          // Wait for the command to complete (file creation + Templater processing)
          await new Promise(resolve => setTimeout(resolve, 300));
          
          const activeFile = this.app.workspace.getActiveFile();
          
          if (!activeFile) {
            sendCallback('ERROR', { message: 'No file opened after daily notes command' });
            return;
          }
          
          console.log('📅 Daily note created/opened:', activeFile.path);
          
          // Get the active leaf and close it
          const activeLeaf = this.app.workspace.getLeaf(false);
          if (activeLeaf) {
            activeLeaf.detach();
            console.log('🗑️ Closed daily note leaf');
          }
          
          // Just return the path - let web UI load it normally
          const response = { success: true, path: activeFile.path };
          sendCallback('OPEN_DAILY_NOTE', response);
          
        } catch (error) {
          console.error('Daily Note Error:', error);
          sendCallback('ERROR', { message: 'Failed to open daily note: ' + error.message });
        }
        return;
      }

    } catch (error) {
      console.error('Portal Command Error:', error);
      sendCallback('ERROR', { message: error.message });
    }
  }

  answerCall(remoteId, offerSignal) {
    // Configure ICE servers (STUN + TURN if available)
    const iceServers = this.iceServers || [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ];
    
    const peer = new SimplePeer({ 
      initiator: false, 
      trickle: false, 
      objectMode: false,
      config: { iceServers }
    });
    let isAuthenticated = false;
    let peerReadOnly = false;
    
    peer.safeSend = (data) => {
      if (peer._channel && peer._channel.readyState === 'open') {
        try {
          peer.send(JSON.stringify(data));
        } catch (e) {
          console.error('Send Fail', e);
        }
      }
    };
    
    peer.sendChunked = async (type, data, meta = {}) => {
      if (!isAuthenticated && type !== 'ERROR') return;
      
      const fullString = JSON.stringify(data);
      const totalBytes = fullString.length;
      let offset = 0;
      
      if (totalBytes > 100000) {
        console.log(`Portal: Sending Large File (${Math.round(totalBytes / 1024)}KB)`);
      }
      
      while (offset < totalBytes) {
        const chunk = fullString.slice(offset, offset + CHUNK_SIZE);
        offset += CHUNK_SIZE;
        peer.safeSend({ type: 'PART', cat: type, chunk, end: offset >= totalBytes, ...meta });
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    
    peer.on('signal', async (data) => {
      await this.supabase.from('signaling').insert({ 
        source: 'host', 
        target: remoteId, 
        type: 'answer', 
        payload: data 
      });
    });
    
    peer.on('connect', () => {
      this.statusBar.setText('Portal: Verifying...');
      
      // Record WebRTC session start
      if (this.settings.enableAnalytics) {
        const network = 'cloud'; // WebRTC connections are remote
        telemetryService.recordSessionStart(network);
      }
    });
    
    peer.on('data', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        
        // Handle authentication with ACL
        if (msg.cmd === 'PING' || msg.cmd === 'HANDSHAKE') {
          let accessGranted = false;
          let isReadOnly = false;
          let userIdentifier = 'unknown';
          
          // Email-based authentication - check if owner or guest
          if (msg.guestEmail && msg.authHash) {
            const userEmail = msg.guestEmail.toLowerCase().trim();
            
            // Check if this is the owner's email
            if (this.settings.userEmail && userEmail === this.settings.userEmail.toLowerCase().trim()) {
              // Owner authentication
              if (this.settings.masterPasswordHash && msg.authHash === this.settings.masterPasswordHash) {
                accessGranted = true;
                isReadOnly = false;
                userIdentifier = this.settings.userEmail;
                console.log('✅ WebRTC: Owner authenticated -', userIdentifier);
              } else {
                console.log('❌ WebRTC: Owner password incorrect');
                peer.safeSend({ type: 'ERROR', message: 'ACCESS_DENIED: Invalid password.' });
                setTimeout(() => peer.destroy(), 1000);
                return;
              }
            }
            // Guest authentication
            else if (this.settings.guestList) {
              console.log('🔍 WebRTC: Verifying guest via backend:', userEmail);
              
              const localGuest = this.settings.guestList.find(g => g.email === userEmail);
              
              if (!localGuest) {
                console.log('❌ WebRTC: Guest not found in local list');
                peer.safeSend({ type: 'ERROR', message: 'ACCESS_DENIED: You do not have access to this vault.' });
                setTimeout(() => peer.destroy(), 1000);
                return;
              }
              
              // Verify password hash
              if (localGuest.passHash !== msg.authHash) {
                console.log('❌ WebRTC: Guest password incorrect');
                peer.safeSend({ type: 'ERROR', message: 'ACCESS_DENIED: Invalid password.' });
                setTimeout(() => peer.destroy(), 1000);
                return;
              }
              
              // Password correct, verify license and backend access
              try {
                // First, verify guest has valid license
                console.log('🔍 WebRTC: Verifying guest license:', userEmail);
                const licenseResponse = await fetch(`${API_BASE_URL}/api/validate-license`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ email: userEmail })
                });
                
                const licenseResult = await licenseResponse.json();
                
                if (!licenseResult.valid) {
                  console.log('❌ WebRTC: Guest license invalid:', licenseResult.reason || 'No active subscription');
                  peer.safeSend({ type: 'ERROR', message: 'LICENSE_REQUIRED: You need an active Note Relay subscription to access shared vaults.' });
                  setTimeout(() => peer.destroy(), 1000);
                  return;
                }
                
                console.log('✅ WebRTC: Guest license valid');
                
                // Then verify they have access to this vault
                const response = await fetch(`${API_BASE_URL}/api/guests?route=check-access`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    vaultId: this.settings.dbVaultId,
                    guestEmail: userEmail
                  })
                });
                
                const result = await response.json();
                
                if (result.allowed) {
                  accessGranted = true;
                  isReadOnly = (localGuest.mode === 'ro');
                  userIdentifier = userEmail;
                  console.log(`✅ WebRTC: Guest authenticated - ${userIdentifier} (${localGuest.mode})`);
                } else {
                  console.log('❌ WebRTC: Guest revoked in backend:', result.reason || 'Not authorized');
                  peer.safeSend({ type: 'ERROR', message: 'ACCESS_DENIED: Your access has been revoked.' });
                  setTimeout(() => peer.destroy(), 1000);
                  return;
                }
              } catch (error) {
                console.error('⚠️ WebRTC: Backend verification failed:', error);
                // Backend down - DENY access (fail secure for guests)
                console.log('❌ WebRTC: Cannot verify guest license/access - backend unavailable');
                peer.safeSend({ type: 'ERROR', message: 'SERVICE_UNAVAILABLE: Cannot verify your subscription. Please try again later.' });
                setTimeout(() => peer.destroy(), 1000);
                return;
              }
            }
          }
          // Legacy: Check local guest list by userId (for backwards compatibility)
          else if (msg.userId && this.settings.guestList) {
            const guest = this.settings.guestList.find(g => g.userId === msg.userId);
            
            if (guest) {
              // Block pending guests
              if (guest.status === 'pending') {
                console.log('❌ WebRTC: Guest pending verification:', guest.email);
                peer.safeSend({ type: 'ERROR', message: 'ACCESS_PENDING: Your access is pending verification. Check your email.' });
                setTimeout(() => peer.destroy(), 1000);
                return;
              }
              
              // Verify password hash
              if (guest.passHash === msg.authHash) {
                accessGranted = true;
                isReadOnly = (guest.mode === 'ro');
                userIdentifier = guest.email || guest.label || guest.userId;
                console.log(`✅ WebRTC: Guest authenticated (legacy) - ${userIdentifier} (${guest.mode})`);
              }
            }
          }
          
          if (accessGranted) {
            isAuthenticated = true;
            peerReadOnly = isReadOnly;
            this.statusBar.setText(`Linked: ${msg.sessionName || userIdentifier}${isReadOnly ? ' (RO)' : ''}`);
            this.statusBar.style.color = '#4caf50';
            peer.safeSend({ 
                type: msg.cmd === 'PING' ? 'PONG' : 'HANDSHAKE_ACK', 
                version: BUILD_VERSION, 
                readOnly: isReadOnly,
                styles: []
            });
            
            // Audit log the connection
            this.logActivity(userIdentifier, 'CONNECTED', 'WebRTC');
          } else {
            console.log('❌ WebRTC: Authentication failed - invalid credentials or not in ACL');
            peer.safeSend({ type: 'ERROR', message: 'ACCESS_DENIED: Invalid credentials or not authorized' });
            setTimeout(() => peer.destroy(), 1000);
          }
          return;
        }
        
        if (!isAuthenticated) return;
        
        // Block write commands if in read-only mode
        const writeCommands = ['CREATE', 'WRITE', 'DELETE', 'RENAME'];
        if (peerReadOnly && writeCommands.includes(msg.cmd)) {
          console.log(`🔒 Blocked ${msg.cmd} command - read-only mode`);
          peer.safeSend({ type: 'ERROR', message: 'READ-ONLY MODE: Editing is disabled' });
          return;
        }
        
        // Use unified command processor with WebRTC send callback
        await this.processCommand(msg, peer.sendChunked);
        
      } catch (e) {
        console.error('Portal Error', e);
      }
    });
    
    peer.on('close', () => {
      new obsidian.Notice('Client Disconnected');
      this.statusBar.setText('Portal: Active');
      this.statusBar.style.color = '';
      
      // Record WebRTC session end
      if (this.settings.enableAnalytics) {
        telemetryService.recordSessionEnd();
      }
    });
    
    peer.on('error', (err) => {
      console.error('Peer error:', err);
      this.statusBar.setText('Portal: Error');
      
      // Record error event
      if (this.settings.enableAnalytics) {
        telemetryService.recordError('webrtc_error', err.message || 'Unknown WebRTC error');
      }
    });
    
    peer.signal(offerSignal);
  }

  async waitForRender(element) {
    // Pre-check: If empty, wait for renderer to start
    if (!element.innerHTML.trim()) {
      await new Promise(r => setTimeout(r, 100));
    }

    return new Promise((resolve) => {
      let timeout = null;
      
      // Safety net: Force resolve after 2 seconds max
      const maxTimeout = setTimeout(() => {
        if (observer) observer.disconnect();
        resolve();
      }, 2000);

      const observer = new MutationObserver((mutations) => {
        // Reset debounce timer on every mutation
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(() => {
          observer.disconnect();
          clearTimeout(maxTimeout);
          resolve();
        }, 100); // Wait for 100ms of silence
      });

      observer.observe(element, {
        attributes: true,
        childList: true,
        subtree: true,
        characterData: true
      });

      // Initial check: if nothing happens in 100ms, assume done (for simple notes)
      timeout = setTimeout(() => {
        observer.disconnect();
        clearTimeout(maxTimeout);
        resolve();
      }, 100);
    });
  }

  async checkConnectionHealth() {
    // Check if signaling connection is still alive
    if (!this.supabase || !this.settings.userEmail) {
      console.log('Note Relay: Connection health check - not connected');
      return;
    }
    
    const timeSinceLastHeartbeat = Date.now() - (this.lastHeartbeatTime || 0);
    
    // If more than 6 minutes since last heartbeat, reconnect
    if (timeSinceLastHeartbeat > 6 * 60 * 1000) {
      console.log('Note Relay: Connection stale, reconnecting...');
      await this.connectSignaling();
    } else {
      console.log('Note Relay: Connection healthy');
    }
  }

  async connectSignaling() {
    // SECURITY CHECK: Do not connect to Supabase if no email is present.
    if (!this.settings.userEmail) {
        console.log('Note Relay: No user email found. Staying offline (Local Mode only).');
        return; // Exit immediately
    }

    // Disconnect existing connection if any
    this.disconnectSignaling();

    this.supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    
    // Check if we have user email for remote access
    let signalId = null;
    if (this.settings.userEmail && this.settings.masterPasswordHash) {
      signalId = await this.registerVaultAndGetSignalId();
    }
    
    // Use signal ID if validated, otherwise fall back to 'host' for testing
    const ID = signalId || 'host';
    
    if (signalId) {
      this.statusBar.setText(`Portal: Pro Active (${ID.slice(0, 8)}...)`);
      this.statusBar.style.color = '#7c4dff';
    } else {
      this.statusBar.setText(`Portal: Active`);
    }
    
    console.log('🎧 Host listening for offers with filter: target=eq.' + ID);
    
    this.channel = this.supabase.channel('host-channel')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'signaling', filter: `target=eq.${ID}` },
        (payload) => {
          console.log('📨 Received signaling message:', payload.new);
          if (payload.new.type === 'offer') {
            console.log('✅ Offer received from:', payload.new.source);
            new obsidian.Notice(`Incoming Connection...`);
            this.answerCall(payload.new.source, payload.new.payload);
          }
        }
      )
      .subscribe();
  }

  extractThemeCSS() {
    // Capture CSS rules AND essential theme variables
    const allCSS = [];
    
    // First, get computed theme variables from body (ensures we get active theme)
    const bodyStyles = getComputedStyle(document.body);
    const essentialVars = [
      '--background-primary',
      '--background-secondary',
      '--background-primary-alt',
      '--background-secondary-alt',
      '--background-modifier-border',
      '--background-modifier-hover',
      '--background-modifier-border-hover',
      '--text-normal',
      '--text-muted',
      '--text-faint',
      '--text-accent',
      '--text-accent-hover',
      '--interactive-accent',
      '--interactive-accent-hover',
      '--tag-background',
      '--tag-color'
    ];
    
    // DEBUG: Log what we're extracting
    console.log('🎨 THEME EXTRACTION DEBUG:');
    
    // Build :root block with essential variables at the top
    let rootVars = ':root {\n';
    essentialVars.forEach(varName => {
      const value = bodyStyles.getPropertyValue(varName).trim();
      console.log(`  ${varName}: ${value || 'NOT FOUND'}`);
      if (value) {
        // Add !important to ensure these override fallbacks
        rootVars += `  ${varName}: ${value} !important;\n`;
      }
    });
    rootVars += '}\n';
    allCSS.push(rootVars);
    
    console.log('📋 Root vars block:', rootVars);
    console.log('📊 Total stylesheet count:', document.styleSheets.length);
    
    // Then capture stylesheet rules (filtered)
    Array.from(document.styleSheets).forEach(sheet => {
      try {
        // Only process if we can access cssRules (CORS check)
        if (sheet.cssRules) {
          Array.from(sheet.cssRules).forEach(rule => {
            const cssText = rule.cssText;
            
            // Skip @font-face rules (contain app:// URLs that fail CORS)
            if (cssText.startsWith('@font-face')) {
              return;
            }
            
            // Skip rules with app:// protocol URLs
            if (cssText.includes('app://')) {
              return;
            }
            
            // Skip rules with /public/ paths (Obsidian internal)
            if (cssText.includes('/public/')) {
              return;
            }
            
            // Include everything else (CSS variables, colors, styles, plugin CSS)
            allCSS.push(cssText);
          });
        }
      } catch (e) {
        // Skip CORS-blocked stylesheets
      }
    });
    
    return allCSS.join('\n');
  }

  extractPluginCSS(pluginClass) {
    // Extract CSS rules that apply to a specific plugin's classes
    const pluginCSS = [];
    const seenRules = new Set(); // Deduplicate rules
    
    // First, add all Obsidian CSS variables that the plugin might use
    const rootVars = getComputedStyle(document.body);
    const obsidianVars = [
      '--size-2-1', '--size-2-2', '--size-2-3',
      '--size-4-1', '--size-4-2', '--size-4-3', '--size-4-4',
      '--size-4-5', '--size-4-6', '--size-4-8', '--size-4-12',
      '--background-primary', '--background-secondary',
      '--background-primary-alt', '--background-secondary-alt',
      '--background-modifier-border', '--background-modifier-border-hover',
      '--background-modifier-border-focus',
      '--text-normal', '--text-muted', '--text-faint',
      '--interactive-accent', '--interactive-hover',
      '--table-border-width', '--table-border-color',
      '--font-text-size', '--font-ui-small', '--font-ui-smaller',
      '--clickable-icon-radius', '--radius-s', '--radius-m',
      '--tag-padding-x', '--tag-padding-y', '--tag-radius'
    ];
    
    let varsBlock = ':root {\n';
    obsidianVars.forEach(varName => {
      const value = rootVars.getPropertyValue(varName).trim();
      if (value) {
        varsBlock += `  ${varName}: ${value};\n`;
      }
    });
    varsBlock += '}\n';
    pluginCSS.push(varsBlock);
    
    // Extract base class name for pattern matching
    // e.g., '.kanban-plugin' -> 'kanban-plugin'
    const baseClassName = pluginClass.replace(/^\./, '');
    
    Array.from(document.styleSheets).forEach(sheet => {
      try {
        if (sheet.cssRules) {
          Array.from(sheet.cssRules).forEach(rule => {
            const cssText = rule.cssText;
            
            // Skip problematic rules
            if (cssText.startsWith('@font-face') || cssText.includes('app://')) {
              return;
            }
            
            // Skip if we've already seen this rule
            if (seenRules.has(cssText)) {
              return;
            }
            
            // Include rules that:
            // 1. Contain the base class name (catches .kanban-plugin, .kanban-plugin__item, etc.)
            // 2. Start with the base class (catches .kanban-plugin { ... })
            if (cssText.includes(baseClassName)) {
              pluginCSS.push(cssText);
              seenRules.add(cssText);
            }
          });
        }
      } catch (e) {
        // CORS error, skip
      }
    });
    
    console.log('🎨 Extracted', pluginCSS.length - 1, 'CSS rules for', baseClassName);
    
    return pluginCSS.join('\n');
  }

  getMimeType(ext) {
    const map = {
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'gif': 'image/gif',
      'svg': 'image/svg+xml',
      'webp': 'image/webp',
      'pdf': 'application/pdf'
    };
    return map[ext.toLowerCase()] || 'application/octet-stream';
  }
  
  /**
   * Zero-Knowledge Audit Log
   * Logs access events locally (console for Phase 1, file in Phase 3)
   * @param {string} userIdentifier - Email or userId of accessor
   * @param {string} action - Action performed (READ, WRITE, DELETE, etc.)
   * @param {string} target - File path or resource accessed
   */
  async logActivity(userIdentifier, action, target, details = null) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [${userIdentifier}] ${action} ${target}`;
    console.log('🔍 AUDIT:', logEntry);
    
    // ZERO KNOWLEDGE: Logs stay LOCAL only
    // Write to /.obsidian/plugins/noterelay/access.log
    try {
      const logFilePath = '.obsidian/plugins/noterelay/access.log';
      const vault = this.app.vault;
      const adapter = vault.adapter;
      
      // Read existing log or create new
      let existingLog = '';
      try {
        existingLog = await adapter.read(logFilePath);
      } catch (e) {
        // File doesn't exist yet, that's fine
      }
      
      // Append new entry
      const newEntry = `${logEntry}${details ? ' ' + JSON.stringify(details) : ''}\n`;
      await adapter.write(logFilePath, existingLog + newEntry);
    } catch (error) {
      console.warn('Failed to write audit log locally:', error);
    }
  }
}

class MicroServerSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.activeTab = 'general';
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    
    // Header
    containerEl.createEl('h2', { text: 'Note Relay Settings' });
    
    // Device Status
    const isHost = true; // Always treat as host
    
    // Server Control Section (at top)
    if (isHost) {
      const serverControlDiv = containerEl.createDiv();
      serverControlDiv.style.cssText = 'padding: 15px; margin-bottom: 20px; border-radius: 6px; background: var(--background-secondary); border-left: 3px solid var(--interactive-accent);';
      
      const statusText = serverControlDiv.createEl('div');
      statusText.style.cssText = 'font-weight: 600; margin-bottom: 10px; font-size: 1.1em;';
      statusText.innerHTML = this.plugin.serverRunning ? '🟢 Web Server Running' : '⚪ Web Server Stopped';
      
      const port = this.plugin.settings.localPort || 5474;
      const urlText = serverControlDiv.createEl('div');
      urlText.style.cssText = 'font-family: monospace; color: var(--text-muted); margin-bottom: 10px; font-size: 0.9em;';
      urlText.setText(`http://localhost:${port}`);
      
      const buttonContainer = serverControlDiv.createEl('div');
      buttonContainer.style.cssText = 'display: flex; gap: 10px;';
      
      new obsidian.Setting(buttonContainer)
        .addButton((b) => b
          .setButtonText(this.plugin.serverRunning ? 'Stop Server' : 'Start Server')
          .onClick(() => {
            if (this.plugin.serverRunning) {
              this.plugin.stopServer();
            } else {
              this.plugin.startServer();
            }
            this.display();
          }))
        .addButton((b) => b
          .setButtonText('Open Browser')
          .setDisabled(!this.plugin.serverRunning)
          .setCta()
          .onClick(() => {
            window.open(`http://localhost:${port}`);
            new obsidian.Notice('Opening web interface...');
          }));
    } else {
      const statusDiv = containerEl.createDiv({ cls: 'portal-status' });
      statusDiv.innerHTML = `<div style="padding: 10px; margin-bottom: 20px; border-radius: 6px; background: rgba(244, 67, 54, 0.1); border-left: 3px solid #f44336;">
        <strong>Device Status:</strong> 🔴 STANDBY
        <div style="margin-top: 5px; font-size: 0.9em; color: #666;">This device is not hosting. Only one device should be active.</div>
      </div>`;
    }
    
    // REMOVED: "Activate This Device" button as it's no longer needed
    
    // Tab Navigation
    const tabContainer = containerEl.createDiv({ cls: 'portal-tab-container' });
    tabContainer.style.cssText = 'display: flex; gap: 10px; margin: 20px 0; border-bottom: 2px solid var(--background-modifier-border);';
    
    const tabs = [
      { id: 'general', label: '🏠 General & Identity' },
      { id: 'remote', label: '🌐 Remote Relay' }
    ];
    
    tabs.forEach(tab => {
      const tabBtn = tabContainer.createEl('button', { 
        text: tab.label,
        cls: this.activeTab === tab.id ? 'portal-tab-active' : 'portal-tab'
      });
      tabBtn.style.cssText = `padding: 10px 20px; border: none; background: ${this.activeTab === tab.id ? 'var(--interactive-accent)' : 'transparent'}; color: ${this.activeTab === tab.id ? 'white' : 'var(--text-muted)'}; cursor: pointer; border-radius: 6px 6px 0 0; font-weight: 600; transition: all 0.2s;`;
      tabBtn.onclick = () => { this.activeTab = tab.id; this.display(); };
    });
    
    // Tab Content
    const contentDiv = containerEl.createDiv({ cls: 'portal-tab-content' });
    contentDiv.style.cssText = 'padding: 20px 0;';
    
    if (this.activeTab === 'general') {
      this.displayGeneralTab(contentDiv);
    } else if (this.activeTab === 'remote') {
      this.displayRemoteTab(contentDiv);
    }
  }
  
  displayGeneralTab(container) {
    // === IDENTITY SECTION (ALWAYS FIRST) ===
    const identitySection = container.createEl('div', { cls: 'identity-section' });
    identitySection.style.cssText = 'padding: 15px; margin-bottom: 25px; background: var(--background-secondary); border-radius: 6px; border-left: 3px solid var(--interactive-accent);';
    
    identitySection.createEl('h3', { text: '👤 Account Identity' });
    identitySection.createEl('p', { 
      text: 'Link your Note Relay account to unlock Remote Access and Usage Analytics.',
      cls: 'setting-item-description'
    });
    
    // Staging variable to prevent false "Connected" state while typing
    let tempEmail = this.plugin.settings.userEmail || '';
    
    // Email Address (moved from Remote tab)
    const emailSetting = new obsidian.Setting(identitySection)
      .setName('Email Address')
      .setDesc('The email address associated with your Note Relay subscription')
      .addText((t) => {
        t.setPlaceholder('your.email@example.com');
        t.setValue(tempEmail);
        t.inputEl.type = 'email';
        t.onChange((value) => {
          // Update staging variable ONLY (no settings, no save, no refresh)
          tempEmail = value.trim().toLowerCase();
        });
      })
      .addButton((b) => b
        .setButtonText('Connect')
        .setCta()
        .onClick(async () => {
          if (!tempEmail) {
            new obsidian.Notice('Please enter your email address');
            return;
          }
          
          // Validate email format
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (!emailRegex.test(tempEmail)) {
            new obsidian.Notice('❌ Please enter a valid email address');
            return;
          }
          
          // UI Feedback
          b.setButtonText('Verifying...');
          b.setDisabled(true);
          
          // Atomic Prep (Clear old state, set new email)
          this.plugin.settings.dbVaultId = '';
          this.plugin.settings.userEmail = tempEmail;
          this.plugin.settings.licenseTier = 'free'; // Reset to default
          await this.plugin.saveSettings();
          
          // THE REAL HANDSHAKE - Verify with server
          const signalId = await this.plugin.registerVaultAndGetSignalId();
          
          // The Verdict
          if (signalId) {
            // SUCCESS - Server confirmed identity
            new obsidian.Notice('✅ Identity verified. Connected.');
            this.display(); // Refresh UI (Green Light)
          } else {
            // FAILURE - ROLLBACK
            this.plugin.settings.userEmail = ''; // Wipe bad email
            this.plugin.settings.dbVaultId = '';
            this.plugin.settings.licenseTier = 'free';
            await this.plugin.saveSettings();
            
            // Error notice already shown by registerVaultAndGetSignalId
            b.setButtonText('Connect');
            b.setDisabled(false);
            this.display(); // Refresh UI (Red Light)
          }
        })
      );
    
    // Add Disconnect button if email is set
    if (this.plugin.settings.userEmail) {
      // Refresh Status button
      emailSetting.addButton((b) => b
        .setIcon('refresh-cw')
        .setTooltip('Refresh license status from server')
        .onClick(async () => {
          new obsidian.Notice('🔄 Refreshing license status...');
          try {
            await this.plugin.registerVaultAndGetSignalId();
            this.display(); // Refresh UI to show updated tier badge
            new obsidian.Notice('✅ License status updated');
          } catch (error) {
            console.error('Failed to refresh license:', error);
            new obsidian.Notice('❌ Failed to refresh. Check your connection.');
          }
        })
      );
      
      // Disconnect button
      emailSetting.addButton((b) => b
        .setButtonText('Disconnect')
        .setClass('mod-warning')
        .onClick(async () => {
          // Confirm destructive action
          const confirmed = confirm('Disconnect your account? This will disable Remote Access and Analytics.');
          if (confirmed) {
            this.plugin.settings.userEmail = '';
            this.plugin.settings.dbVaultId = '';
            tempEmail = ''; // Clear staging variable
            this.plugin.disconnectSignaling();
            await this.plugin.saveSettings();
            new obsidian.Notice('Account disconnected');
            this.display(); // Force UI refresh to show disconnected state
          }
        })
      );
    }
    
    const emailStatus = identitySection.createDiv({ cls: 'setting-item-description' });
    emailStatus.style.cssText = 'margin: -10px 0 15px 0; padding-left: 0; display: flex; align-items: center; gap: 10px;';
    
    if (this.plugin.settings.userEmail) {
      // Create badge based on license tier
      const tier = this.plugin.settings.licenseTier || 'free';
      let badgeText, badgeColor, badgeBackground;
      
      if (tier === 'pro') {
        badgeText = 'PRO PLAN';
        badgeColor = '#ffd700';  // Gold
        badgeBackground = 'rgba(255, 215, 0, 0.15)';
      } else if (tier === 'base') {
        badgeText = 'BASE PLAN';
        badgeColor = 'var(--interactive-accent)';
        badgeBackground = 'var(--background-modifier-hover)';
      } else {
        badgeText = 'FREE TIER';
        badgeColor = 'var(--text-muted)';
        badgeBackground = 'var(--background-modifier-border)';
      }
      
      // Dynamic message based on tier
      let statusMessage;
      if (tier === 'free') {
        statusMessage = 'Email saved - Analytics unlocked (Upgrade for Remote Access)';
      } else {
        statusMessage = 'Email saved - Remote Access and Analytics unlocked';
      }
      
      emailStatus.innerHTML = `
        ✅ <strong style="color: #4caf50;">${statusMessage}</strong>
        <span class="tier-badge" style="padding: 2px 8px; border-radius: 4px; font-size: 0.8em; font-weight: bold; color: ${badgeColor}; background: ${badgeBackground};">${badgeText}</span>
      `;
    } else {
      emailStatus.setText('⚠️ Enter your email to enable Remote Access and Usage Dashboard');
    }
    
    // === LOCAL SERVER CONFIGURATION ===
    container.createEl('h3', { text: 'Local Server Configuration' });
    
    // Read-Write Password
    const localPassSetting = new obsidian.Setting(container)
      .setName('Read-Write Password')
      .setDesc('Password for full editing access to your vault')
      .addText((t) => {
        t.setPlaceholder('Enter read-write password');
        t.inputEl.type = 'password';
        t.onChange((v) => this.newPass = v);
      })
      .addButton((b) => b
        .setButtonText('Update')
        .setCta()
        .onClick(async () => {
          if (this.newPass) {
            this.plugin.settings.passwordHash = await hashString(this.newPass);
            await this.plugin.saveSettings();
            new obsidian.Notice('Read-write password updated');
            this.newPass = '';
            this.display();
          }
        }));
    
    // Add Clear button if password is set
    if (this.plugin.settings.passwordHash) {
      localPassSetting.addButton((b) => b
        .setButtonText('Clear')
        .setClass('mod-warning')
        .onClick(async () => {
          const confirmed = confirm('Clear your local password? This will remove password protection.');
          if (confirmed) {
            this.plugin.settings.passwordHash = '';
            await this.plugin.saveSettings();
            new obsidian.Notice('Local password cleared');
            this.display();
          }
        })
      );
    }
    
    const passStatus = container.createDiv({ cls: 'setting-item-description' });
    passStatus.style.cssText = 'margin: -10px 0 20px 0; padding-left: 0;';
    passStatus.setText(this.plugin.settings.passwordHash ? '✅ Password is set (local access is always read-write)' : '⚠️ No password set');
    
    // Port Configuration
    new obsidian.Setting(container)
      .setName('Server Port')
      .setDesc('Port number for the local web server (requires plugin reload)')
      .addText((t) => t
        .setPlaceholder('5474')
        .setValue(String(this.plugin.settings.localPort || 5474))
        .onChange(async (value) => {
          const port = parseInt(value);
          if (port > 1024 && port < 65535) {
            this.plugin.settings.localPort = port;
            await this.plugin.saveSettings();
          }
        }));
    
    // CORS Security Settings
    container.createEl('h3', { text: 'Security Settings', cls: 'setting-item-heading' });
    
    new obsidian.Setting(container)
      .setName('Restrict Access')
      .setDesc('Only allow connections from localhost. Disable this ONLY if you use a custom SSL proxy.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.corsRestricted ?? true)
        .onChange(async (value) => {
          this.plugin.settings.corsRestricted = value;
          await this.plugin.saveSettings();
          new obsidian.Notice('Restart the server for security changes to take effect');
        }));

    new obsidian.Setting(container)
      .setName('Allowed Domains')
      .setDesc('Comma-separated list of custom domains (e.g., https://my-vault.com). Leave empty for default security.')
      .addText(text => text
        .setPlaceholder('https://example.com')
        .setValue(this.plugin.settings.corsAllowedOrigins || '')
        .onChange(async (value) => {
          this.plugin.settings.corsAllowedOrigins = value;
          await this.plugin.saveSettings();
        }));

    // Analytics Privacy Settings
    container.createEl('h3', { text: '📊 Vault Insights', cls: 'setting-item-heading' });
    
    // Analytics toggle - only available for users with email linked
    const analyticsToggle = new obsidian.Setting(container)
      .setName('Enable Usage Dashboard');
    
    if (!this.plugin.settings.userEmail) {
      // No email - disable toggle and show requirement
      analyticsToggle
        .setDesc('Link your account above to unlock your personal usage dashboard and help shape future features.')
        .addToggle(toggle => toggle
          .setValue(false)
          .setDisabled(true)
        );
    } else {
      // Email linked - show normal toggle
      analyticsToggle
        .setDesc('Unlock your personal dashboard to track vault access and traffic trends. This anonymous data also helps us identify usage patterns to prioritize new features. (Strictly non-identifiable).')
        .addToggle(toggle => toggle
          .setValue(this.plugin.settings.enableAnalytics ?? true)
          .onChange(async (value) => {
            this.plugin.settings.enableAnalytics = value;
            await this.plugin.saveSettings();
            
            // Reinitialize telemetry service (registered users only)
            if (value && this.plugin.settings.dbVaultId) {
              telemetryService.init(this.plugin.settings.dbVaultId, true);
              new obsidian.Notice('Analytics enabled');
            } else {
              telemetryService.destroy();
              new obsidian.Notice('Analytics disabled');
            }
          })
        );
    }

  }
  
  displayRemoteTab(container) {
    // === GATEKEEPER: IDENTITY REQUIRED ===
    if (!this.plugin.settings.userEmail) {
      const errorBlock = container.createEl('div', {
        cls: 'setting-error-block'
      });
      errorBlock.style.cssText = 'color: var(--text-error); font-weight: bold; padding: 15px; border: 2px solid var(--text-error); border-radius: 6px; background: rgba(244, 67, 54, 0.1); margin: 20px 0;';
      errorBlock.innerHTML = '⚠️ <strong>Identity Required:</strong> Please enter your email in the General tab to configure Remote Access.';
      return; // STOP RENDERING THE REST OF THE TAB
    }
    
    // Define tier (base and pro both get remote access)
    const isPro = ['base', 'pro'].includes(this.plugin.settings.licenseTier);
    
    container.createEl('h3', { text: 'Remote Relay Configuration' });
    
    // Show upgrade CTA if not Pro/Base (Glass Wall UX)
    if (!isPro) {
      const upgradeBanner = container.createDiv();
      upgradeBanner.style.cssText = 'padding: 20px; margin-bottom: 20px; text-align: center; background: rgba(255, 215, 0, 0.1); border: 2px solid #ffd700; border-radius: 6px;';
      upgradeBanner.innerHTML = `
        <div style="font-size: 32px; margin-bottom: 10px;">🚀</div>
        <div style="font-weight: bold; font-size: 1.2em; margin-bottom: 8px;">Upgrade to Unlock Remote Access</div>
        <div style="color: var(--text-muted); margin-bottom: 15px;">
          Access your vault from anywhere with global relay connectivity.<br>
          Available on <strong style="color: #ffd700;">Base ($1.99/mo)</strong> and <strong style="color: #ffd700;">Pro ($3.99/mo)</strong> plans.
        </div>
        <button class="mod-cta" style="padding: 10px 30px; background: #ffd700; color: #000; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">
          View Plans
        </button>
      `;
      upgradeBanner.querySelector('button').onclick = () => {
        window.open('https://noterelay.io/dashboard');
      };
    }
    
    // Setup instructions banner
    const isActive = this.plugin.signalId && this.plugin.heartbeatInterval;
    const hasEmail = !!this.plugin.settings.userEmail;
    const hasMasterPass = !!this.plugin.settings.masterPasswordHash;
    
    if (!isActive) {
      const setupBanner = container.createDiv();
      setupBanner.style.cssText = 'padding: 15px; margin-bottom: 20px; background: var(--background-secondary); border-radius: 6px; border-left: 3px solid var(--interactive-accent);';
      
      let steps = [];
      if (!hasMasterPass) steps.push('1️⃣ Set your master password (Owner access)');
      if (!hasEmail) steps.push(`${hasMasterPass ? '2️⃣' : '1️⃣'} Enter your email address`);
      if (hasMasterPass && hasEmail) steps.push('3️⃣ Click "Activate Remote Access" below');
      
      setupBanner.innerHTML = `
        <div style="font-weight: 600; margin-bottom: 8px;">🚀 Setup Required</div>
        <div style="font-size: 0.9em; color: var(--text-muted);">
          ${steps.length > 0 ? steps.join('<br>') : 'Ready to activate!'}
        </div>
      `;
    }
    
    // Remote Vault Password
    const remotePassSetting = new obsidian.Setting(container)
      .setName('Remote Vault Password')
      .setDesc(isPro ? 'Set a secure password for remote connections via the global relay. (Distinct from your Local Password)' : '🔒 Upgrade to Base or Pro to enable remote access')
      .addText((t) => {
        t.setPlaceholder(isPro ? 'Enter a strong master password' : 'Requires Base or Pro plan');
        t.inputEl.type = 'password';
        t.setDisabled(!isPro);
        if (isPro) {
          t.onChange((v) => this.newMasterPass = v);
        }
      })
      .addButton((b) => b
        .setButtonText(isPro ? 'Set Master Password' : 'Set Master Password (Pro Required)')
        .setCta()
        .setDisabled(!isPro)
        .onClick(async () => {
          if (!isPro) return;
          if (this.newMasterPass) {
            this.plugin.settings.masterPasswordHash = await hashString(this.newMasterPass);
            await this.plugin.saveSettings();
            new obsidian.Notice('✅ Master password set');
            this.newMasterPass = '';
            this.display();
          } else {
            new obsidian.Notice('Please enter a password');
          }
        }));
    
    // Add Clear button if master password is set
    if (this.plugin.settings.masterPasswordHash && isPro) {
      remotePassSetting.addButton((b) => b
        .setButtonText('Clear')
        .setClass('mod-warning')
        .setDisabled(!isPro)
        .onClick(async () => {
          if (!isPro) return;
          const confirmed = confirm('Clear your remote password? This will disable remote vault access.');
          if (confirmed) {
            this.plugin.settings.masterPasswordHash = '';
            this.plugin.disconnectSignaling(); // Disconnect if active
            await this.plugin.saveSettings();
            new obsidian.Notice('Remote password cleared');
            this.display();
          }
        })
      );
    }
    
    const masterPassStatus = container.createDiv({ cls: 'setting-item-description' });
    masterPassStatus.style.cssText = 'margin: -10px 0 20px 0; padding-left: 0;';
    if (!isPro) {
      masterPassStatus.innerHTML = '🔒 <span style="color: var(--text-muted);">Upgrade to unlock remote vault access</span>';
    } else {
      masterPassStatus.setText(this.plugin.settings.masterPasswordHash ? '✅ Remote password is set' : '⚠️ Required - Set a password for remote vault access');
    }
    
    // Activation Button
    const canActivate = hasMasterPass && hasEmail && isPro;
    const activationSetting = new obsidian.Setting(container)
      .setName('Activate Remote Access')
      .setDesc(!isPro ? '🔒 Requires Base or Pro subscription to connect to global relay' : canActivate ? 'Click to validate your subscription and register this vault for remote access via the global relay' : 'Set a remote password above to continue');
    
    activationSetting.addButton((b) => {
      b.setButtonText(!isPro ? 'Activate Remote Access (Pro Required)' : isActive ? '🟢 Active - Click to Re-register' : 'Activate Remote Access')
        .setCta()
        .setDisabled(!canActivate)
        .onClick(async () => {
          if (!isPro) return;
          // Validate license before connecting
          new obsidian.Notice('Checking subscription...');
          
          try {
            const licenseResponse = await fetch(`${API_BASE_URL}/api/validate-license`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email: this.plugin.settings.userEmail })
            });
            
            const licenseResult = await licenseResponse.json();
            
            if (!licenseResult.valid) {
              const reason = licenseResult.reason || 'No active subscription';
              new obsidian.Notice(`❌ Remote access requires an active subscription.\n\n${reason}\n\nVisit noterelay.io/dashboard to subscribe.`, 10000);
              
              // Show upgrade modal
              const modal = new obsidian.Modal(this.app);
              modal.titleEl.setText('Subscription Required');
              modal.contentEl.innerHTML = `
                <div style="padding: 20px; text-align: center;">
                  <div style="font-size: 48px; margin-bottom: 20px;">🔒</div>
                  <h3>Remote Access Requires a Subscription</h3>
                  <p style="color: var(--text-muted); margin: 15px 0;">
                    ${reason}
                  </p>
                  <p style="margin: 20px 0;">
                    Subscribe to <strong>Base ($1.99/month)</strong> or <strong>Pro ($3.99/month)</strong> to enable remote vault access.
                  </p>
                  <button class="mod-cta" style="padding: 10px 30px; margin-top: 10px;">
                    View Plans & Subscribe
                  </button>
                </div>
              `;
              modal.contentEl.querySelector('button').onclick = () => {
                window.open('https://noterelay.io/dashboard');
                modal.close();
              };
              modal.open();
              return;
            }
            
            // Valid license - proceed with registration
            new obsidian.Notice('Subscription verified! Registering vault...');
            
            await this.plugin.connectSignaling();
            
            if (this.plugin.signalId) {
              new obsidian.Notice('✅ Success! Your vault is now accessible remotely.');
              this.display();
            } else {
              new obsidian.Notice('❌ Registration failed. Please try again or contact support.');
            }
          } catch (error) {
            console.error('License validation error:', error);
            new obsidian.Notice('❌ Failed to validate subscription. Check your internet connection.');
          }
        });
      
      if (!canActivate) {
        b.buttonEl.style.opacity = '0.5';
      }
    });
    
    const activationStatus = container.createDiv({ cls: 'setting-item-description' });
    activationStatus.style.cssText = 'margin: -10px 0 20px 0; padding-left: 0;';
    
    if (!canActivate) {
      activationStatus.innerHTML = '⚠️ <strong>Both master password and email address required above</strong>';
    } else if (isActive) {
      activationStatus.innerHTML = '✅ <strong style="color: #4caf50;">Your vault is online and ready for remote connections</strong>';
    } else {
      activationStatus.setText('Ready to activate - Click the button above');
    }
    
    // GUEST MANAGER SECTION
    container.createEl('h3', { text: 'Guest Access Control', cls: 'setting-item-heading' });
    
    // Check if user has Pro tier (Guest Manager requires Pro specifically, not Base)
    const hasGuestAccess = this.plugin.settings.licenseTier === 'pro';
    
    const guestManagerDiv = container.createDiv();
    guestManagerDiv.style.cssText = 'padding: 20px; background: var(--background-secondary); border-radius: 6px; margin: 20px 0;';
    
    // Show upgrade CTA if not Pro
    if (!hasGuestAccess) {
      const upgradeCTA = guestManagerDiv.createDiv();
      upgradeCTA.style.cssText = 'padding: 20px; text-align: center; background: rgba(255, 215, 0, 0.1); border: 2px solid #ffd700; border-radius: 6px; color: var(--text-normal);';
      upgradeCTA.innerHTML = `
        <div style="font-size: 32px; margin-bottom: 10px;">🔒</div>
        <div style="font-weight: bold; font-size: 1.1em; margin-bottom: 8px;">Pro Feature: Guest Vault Sharing</div>
        <div style="color: var(--text-muted); margin-bottom: 15px;">
          Upgrade to <strong style="color: #ffd700;">Pro Plan</strong> to share your vault with guests using read-only or read-write access.
        </div>
        <button class="mod-cta" style="padding: 10px 30px; background: #ffd700; color: #000; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">
          Upgrade to Pro
        </button>
      `;
      upgradeCTA.querySelector('button').onclick = () => {
        window.open('https://noterelay.io/dashboard');
      };
      return; // Stop rendering guest controls
    }
    
    // Add Guest Form (only for Pro users)
    guestManagerDiv.createEl('h4', { text: 'Add New Guest' });
    
    const addGuestForm = guestManagerDiv.createDiv();
    addGuestForm.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 20px;';
    
    // Email input
    const emailInput = addGuestForm.createEl('input', { 
      type: 'email', 
      placeholder: 'guest@example.com' 
    });
    emailInput.style.cssText = 'padding: 8px; border-radius: 4px; border: 1px solid var(--background-modifier-border); background: var(--background-primary);';
    emailInput.disabled = !isPro;
    
    // Label input
    const labelInput = addGuestForm.createEl('input', { 
      type: 'text', 
      placeholder: 'Display name (e.g., "Bob")' 
    });
    labelInput.style.cssText = 'padding: 8px; border-radius: 4px; border: 1px solid var(--background-modifier-border); background: var(--background-primary);';
    labelInput.disabled = !isPro;
    
    // Password input
    const guestPassInput = addGuestForm.createEl('input', { 
      type: 'password', 
      placeholder: 'Password for guest' 
    });
    guestPassInput.style.cssText = 'padding: 8px; border-radius: 4px; border: 1px solid var(--background-modifier-border); background: var(--background-primary);';
    guestPassInput.disabled = !isPro;
    
    // Mode selector
    const modeSelect = addGuestForm.createEl('select');
    modeSelect.style.cssText = 'padding: 8px; border-radius: 4px; border: 1px solid var(--background-modifier-border); background: var(--background-primary);';
    modeSelect.createEl('option', { text: 'Read-Write', value: 'rw' });
    modeSelect.createEl('option', { text: 'Read-Only', value: 'ro' });
    modeSelect.disabled = !isPro;
    
    // Add button
    const addGuestBtn = addGuestForm.createEl('button', { text: 'Add Guest' });
    addGuestBtn.style.cssText = 'padding: 8px 16px; background: var(--interactive-accent); color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: 600;';
    addGuestBtn.disabled = !isPro;
    addGuestBtn.onclick = async () => {
      const email = emailInput.value.trim();
      const label = labelInput.value.trim();
      const password = guestPassInput.value;
      const mode = modeSelect.value;
      
      if (!email || !password) {
        new obsidian.Notice('Email and password are required');
        return;
      }
      
      // Validate email format
      if (!email.includes('@')) {
        new obsidian.Notice('Invalid email format');
        return;
      }
      
      // Hash the password
      const passHash = await hashString(password);
      
      // Add to guest list
      if (!this.plugin.settings.guestList) {
        this.plugin.settings.guestList = [];
      }
      
      // Check for duplicates
      if (this.plugin.settings.guestList.some(g => g.email === email)) {
        new obsidian.Notice('This guest already exists');
        return;
      }
      
      // Check for Collaboration Pack before allowing guest addition
      try {
        // First check vault is registered
        if (!this.plugin.settings.dbVaultId) {
          new obsidian.Notice('⚠️ Vault not registered yet. Activate vault first in Step 3.');
          return;
        }
        
        // Validate Collaboration Pack
        new obsidian.Notice('Checking subscription...');
        
        const licenseResponse = await fetch(`${API_BASE_URL}/api/validate-license`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: this.plugin.settings.userEmail })
        });
        
        const licenseResult = await licenseResponse.json();
        
        if (!licenseResult.valid || !licenseResult.features.includes('guest-sharing')) {
          const reason = licenseResult.reason || 'Collaboration Pack required';
          new obsidian.Notice(`❌ Guest sharing requires Collaboration Pack.\n\n${reason}\n\nVisit noterelay.io/dashboard to upgrade.`, 10000);
          
          // Show upgrade modal
          const modal = new obsidian.Modal(this.app);
          modal.titleEl.setText('Collaboration Pack Required');
          modal.contentEl.innerHTML = `
            <div style="padding: 20px; text-align: center;">
              <div style="font-size: 48px; margin-bottom: 20px;">👥</div>
              <h3>Guest Sharing Requires Pro Plan</h3>
              <p style="color: var(--text-muted); margin: 15px 0;">
                ${reason}
              </p>
              <p style="margin: 20px 0;">
                Upgrade to <strong>Pro ($3.99/month)</strong> to share your vault with guests.
              </p>
              <ul style="text-align: left; margin: 20px auto; max-width: 300px;">
                <li>Add unlimited guests</li>
                <li>Set read-only or read-write permissions</li>
                <li>Track access with audit logs</li>
                <li>Revoke access anytime</li>
              </ul>
              <button class="mod-cta" style="padding: 10px 30px; margin-top: 10px;">
                Upgrade to Pro Plan
              </button>
            </div>
          `;
          modal.contentEl.querySelector('button').onclick = () => {
            window.open('https://noterelay.io/dashboard');
            modal.close();
          };
          modal.open();
          return;
        }
        
        // Valid Collaboration Pack - proceed with adding guest
        new obsidian.Notice('Subscription verified! Adding guest...');
        
        const response = await fetch(`${API_BASE_URL}/api/guests?route=add`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vaultId: this.plugin.settings.dbVaultId,
            email: this.plugin.settings.userEmail,
            guestEmail: email,
            permission: mode === 'ro' ? 'read-only' : 'full-access'
          })
        });
        
        if (!response.ok) {
          const error = await response.json();
          new obsidian.Notice(`Failed to add guest: ${error.error}`);
          console.error('Add guest error:', error);
          return;
        }
        
        // Backend sync successful, add to local settings
        this.plugin.settings.guestList.push({
          userId: '', // Will be populated by backend after verification
          email: email,
          passHash: passHash,
          mode: mode,
          label: label || email,
          status: 'approved' // Backend already approved
        });
        
        await this.plugin.saveSettings();
        
        new obsidian.Notice(`✅ Guest added: ${email} (${mode.toUpperCase()})`);
        
        // Clear form
        emailInput.value = '';
        labelInput.value = '';
        guestPassInput.value = '';
        
        this.display();
      } catch (error) {
        console.error('Failed to add guest:', error);
        new obsidian.Notice('Network error: Could not sync guest to backend');
      }
    };
    
    // Guest List Display
    guestManagerDiv.createEl('h4', { text: 'Current Guests', cls: 'setting-item-heading' });
    
    const guestList = this.plugin.settings.guestList || [];
    
    if (guestList.length === 0) {
      const emptyMsg = guestManagerDiv.createDiv();
      emptyMsg.style.cssText = 'padding: 15px; text-align: center; color: var(--text-muted); font-style: italic;';
      emptyMsg.setText('No guests added yet');
    } else {
      const guestTable = guestManagerDiv.createDiv();
      guestTable.style.cssText = 'display: grid; grid-template-columns: 2fr 1fr 1fr 1fr auto; gap: 10px; align-items: center;';
      
      // Header
      ['Email/Label', 'Mode', 'Status', 'User ID', 'Action'].forEach(header => {
        const th = guestTable.createEl('div', { text: header });
        th.style.cssText = 'font-weight: 600; padding: 8px; border-bottom: 2px solid var(--background-modifier-border);';
      });
      
      // Rows
      guestList.forEach((guest, index) => {
        // Email/Label
        const emailCell = guestTable.createEl('div');
        emailCell.style.cssText = 'padding: 8px;';
        emailCell.innerHTML = `<div style="font-weight: 500;">${guest.label || guest.email}</div><div style="font-size: 0.85em; color: var(--text-muted);">${guest.email}</div>`;
        
        // Mode
        const modeCell = guestTable.createEl('div', { text: guest.mode === 'rw' ? '✏️ Read-Write' : '👁️ Read-Only' });
        modeCell.style.cssText = 'padding: 8px; font-size: 0.9em;';
        
        // Status
        const statusCell = guestTable.createEl('div');
        statusCell.style.cssText = 'padding: 8px;';
        if (guest.status === 'verified') {
          statusCell.innerHTML = '<span style="color: #4caf50;">✅ Verified</span>';
        } else {
          statusCell.innerHTML = '<span style="color: #ff9800;">⏳ Pending</span>';
        }
        
        // User ID
        const userIdCell = guestTable.createEl('div', { text: guest.userId || 'N/A' });
        userIdCell.style.cssText = 'padding: 8px; font-size: 0.85em; font-family: monospace; color: var(--text-muted);';
        
        // Revoke button
        const actionCell = guestTable.createEl('div');
        actionCell.style.cssText = 'padding: 8px;';
        const revokeBtn = actionCell.createEl('button', { text: '🗑️ Revoke' });
        revokeBtn.style.cssText = 'padding: 4px 8px; background: var(--background-modifier-error); color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.85em;';
        revokeBtn.onclick = async () => {
          try {
            // Try to sync to backend first (if vault is registered)
            if (this.plugin.settings.dbVaultId) {
              const response = await fetch(`${API_BASE_URL}/api/guests?route=revoke`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  vaultId: this.plugin.settings.dbVaultId,
                  email: this.plugin.settings.userEmail,
                  guestEmail: guest.email
                })
              });
            
              if (!response.ok && response.status !== 404) {
                // Only fail if it's not a 404 (guest might be local-only from before backend existed)
                const error = await response.json();
                new obsidian.Notice(`Failed to revoke: ${error.error}`);
                return;
              }
            }
            
            // Backend sync successful OR guest was local-only, remove from local settings
            this.plugin.settings.guestList.splice(index, 1);
            await this.plugin.saveSettings();
            new obsidian.Notice(`Revoked access: ${guest.email}`);
            this.display();
          } catch (error) {
            console.error('Failed to revoke guest:', error);
            new obsidian.Notice('Network error: Could not sync revocation to backend');
          }
        };
      });
    }
    
    // Status & Info Section
    const infoDiv = container.createDiv();
    infoDiv.style.cssText = 'padding: 20px; background: var(--background-secondary); border-radius: 6px; margin: 20px 0;';
    
    const vaultIsActive = this.plugin.signalId && this.plugin.heartbeatInterval;
    
    if (vaultIsActive) {
      // Show success state for active/validated subscriptions
      infoDiv.innerHTML = `
        <h4 style="margin-top: 0; color: #4caf50;">✅ Remote Access Active</h4>
        <div style="margin: 15px 0; padding: 15px; background: var(--background-primary-alt); border-radius: 4px;">
          <div style="margin-bottom: 10px;"><strong>Email:</strong> <code style="font-size: 0.9em;">${this.plugin.settings.userEmail}</code></div>
          <div style="margin-bottom: 10px;"><strong>Vault:</strong> ${this.plugin.app.vault.getName()}</div>
          <div><strong>Status:</strong> <span style="color: #4caf50;">🟢 Online</span> (heartbeat active)</div>
        </div>
        <div style="margin-top: 15px; padding: 10px; background: rgba(124, 77, 255, 0.1); border-radius: 4px;">
          📱 <strong>Access Your Vault:</strong> Go to <a href="https://noterelay.io/dashboard.html" target="_blank" style="color: var(--interactive-accent);">Dashboard</a> and click "Connect"
        </div>
        <div style="margin-top: 10px; font-size: 0.9em; color: var(--text-muted);">
          💡 <strong>Tip:</strong> Keep this plugin running to maintain remote access. Closing Obsidian will disconnect your vault.
        </div>
      `;
    } else {
      // Show setup instructions for inactive subscriptions
      infoDiv.innerHTML = `
        <h4 style="margin-top: 0;">🌐 Remote Access Setup</h4>
        <div style="margin: 15px 0; padding: 15px; background: var(--background-primary-alt); border-radius: 4px;">
          <strong>Quick Start:</strong>
          <ol style="margin: 10px 0; padding-left: 20px;">
            <li>Set your master password above</li>
            <li>Enter your email address (same as your subscription)</li>
            <li>Click "Activate Remote Access" button</li>
            <li>Go to <a href="https://noterelay.io/dashboard.html" target="_blank" style="color: var(--interactive-accent);">Dashboard</a> to connect</li>
          </ol>
        </div>
        <div style="margin-top: 15px; padding: 10px; background: rgba(124, 77, 255, 0.1); border-radius: 4px;">
          💎 <strong>Don't have a subscription?</strong> <a href="https://noterelay.io/#pricing" target="_blank" style="color: var(--interactive-accent);">Get Pro Access</a>
        </div>
      `;
    }
  }
  
}

module.exports = MicroServer;
