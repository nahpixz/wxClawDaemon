import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import axios from 'axios';
import { WebSocketServer, WebSocket } from 'ws';
import open from 'open';
import winston from 'winston';
import * as gui from './gui.js';

const STORE_DEFAULTS = {
    wxAppId: '',
    fallBackWebhookUrl: '',
    // wxApiUrl:'/wecom/callback',
    // openclawHost:'127.0.0.1',
    // openclawPort:18789,
    // cloudflaredBinPath: 'cloudflared',
    // cloudflaredConfig: 'cloudflared.yaml',
    // metricsPort: 55555,
    // checkInterval: 30000,
    // wsPort: 18790, // Port for WebSocket communication with extension
}

const STORE_DIR = path.join(process.env.APPDATA || process.cwd(), 'wxclaw_daemon');
const CONFIG_FILE = path.join(STORE_DIR, 'config.json');
const STATE_FILE = path.join(STORE_DIR, 'state.json');
const LOG_FILE = path.join(STORE_DIR, 'daemon.log');

function loadConfig() {
    try {
        fs.mkdirSync(STORE_DIR, { recursive: true });
        if (!fs.existsSync(CONFIG_FILE)) {
            return { ...STORE_DEFAULTS };
        }
        const content = fs.readFileSync(CONFIG_FILE, 'utf8');
        const parsed = JSON.parse(content);
        return { ...STORE_DEFAULTS, ...parsed };
    } catch (error) {
        console.error(`Failed to load config file ${CONFIG_FILE}: ${error.message}`);
        return { ...STORE_DEFAULTS };
    }
}

const STORE = loadConfig();

// Persistent State (usingIp, usingTunnelUrl)
const STATE_DEFAULTS = {
    usingIp: '',
    usingTunnelUrl: ''
};

function loadState() {
    try {
        if (!fs.existsSync(STATE_FILE)) {
            return { ...STATE_DEFAULTS };
        }
        const content = fs.readFileSync(STATE_FILE, 'utf8');
        return { ...STATE_DEFAULTS, ...JSON.parse(content) };
    } catch (error) {
        console.error(`Failed to load state file: ${error.message}`);
        return { ...STATE_DEFAULTS };
    }
}

const PERSISTENT_STATE = loadState();

function persistState() {
    try {
        const tempFile = `${STATE_FILE}.tmp`;
        fs.writeFileSync(tempFile, JSON.stringify(PERSISTENT_STATE, null, 2), 'utf8');
        fs.renameSync(tempFile, STATE_FILE);
    } catch (error) {
        logger.error(`Failed to persist state: ${error.message}`);
    }
}
const CLAW_URL = `http://${STORE.openclawHost||'127.0.0.1'}:${STORE.openclawPort||18789}${STORE.wxApiUrl||'/wecom/callback'}`;
// Configuration
const CONFIG = {
    cloudflaredBin: STORE.cloudflaredBinPath||'cloudflared', // Assume in PATH or current directory
    cloudflaredArgs: [
        'tunnel',
        '--config', STORE.cloudflaredConfig||'cloudflared.yaml',
        '--url', CLAW_URL,
        '--metrics', `127.0.0.1:${STORE.metricsPort||55555}`
    ],
    metricsUrl: `http://127.0.0.1:${STORE.metricsPort||55555}/quicktunnel`,
    ipCheckUrl: 'http://myip.ipip.net/ip',//'https://api.myip.la',
    targetUrl: `https://work.weixin.qq.com/wework_admin/frame#/apps/modApiApp/${STORE.wxAppId||''}`,
    wxApiUrl:STORE.wxApiUrl||'/wecom/callback',
    wsPort: STORE.wsPort||18790, // Port for WebSocket communication with extension
    wsHost: '127.0.0.1', // Bind to all interfaces for flexibility
    checkInterval: STORE.checkInterval||30000, // 30 seconds for checks
};

// Logger Setup
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => {
            return `${timestamp} [${level.toUpperCase()}]: ${message}`;
        })
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: LOG_FILE })
    ]
});

// State
let state = {
    currentIp: null,
    currentTunnelUrl: null,
    cloudflaredProcess: null,
    wsServer: null,
    browserConnected: false,
    lastBrowserHeartbeat: Date.now()
};

async function openConfigDirectory(dirPath) {
    if (!dirPath) return false;
    try {
        if (process.platform === 'win32') {
            const child = spawn('explorer.exe', [dirPath], {
                detached: true,
                stdio: 'ignore'
            });
            child.unref();
            return true;
        }
        await open(dirPath, { wait: false });
        return true;
    } catch (error) {
        logger.error(`Failed to open config directory: ${error.message}`);
        return false;
    }
}

async function sendFallbackLoginScreenshot(base64Image) {
    if (!STORE.fallBackWebhookUrl) {
        logger.warn('fallBackWebhookUrl is not configured, skipping login screenshot forward.');
        return;
    }
    if (!base64Image || typeof base64Image !== 'string') {
        logger.warn('Invalid login screenshot payload.');
        return;
    }
    const rawBase64 = base64Image.includes(',') ? base64Image.split(',').pop() : base64Image;
    const imageBuffer = Buffer.from(rawBase64, 'base64');
    const md5 = crypto.createHash('md5').update(imageBuffer).digest('hex');
    await axios.post(STORE.fallBackWebhookUrl, {
        msgtype: 'image',
        image: {
            base64: rawBase64,
            md5
        }
    }, {
        headers: {
            'Content-Type': 'application/json'
        },
        timeout: 10000
    });
    logger.info('Login screenshot sent to fallback webhook.');
}

async function handleLoginQrcodeUrl(url) {
    if (!STORE.fallBackWebhookUrl) {
        logger.warn('fallBackWebhookUrl is not configured, skipping QR code download.');
        return;
    }
    if (!url || !url.startsWith('http')) {
        logger.warn(`Invalid QR code URL: ${url}`);
        return;
    }

    try {
        logger.info(`Downloading QR code from ${url}...`);
        // Add timestamp to prevent caching if needed, though usually unique per session
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 10000
        });

        const imageBuffer = Buffer.from(response.data);
        const base64 = imageBuffer.toString('base64');
        const md5 = crypto.createHash('md5').update(imageBuffer).digest('hex');

        await axios.post(STORE.fallBackWebhookUrl, {
            msgtype: 'image',
            image: {
                base64: base64,
                md5
            }
        }, {
            headers: {
                'Content-Type': 'application/json'
            },
            timeout: 10000
        });
        logger.info('Login QR code downloaded and sent to fallback webhook.');
    } catch (error) {
        logger.error(`Failed to process QR code URL: ${error.message}`);
    }
}

async function sendFallbackTextNotify(content) {
    if (!STORE.fallBackWebhookUrl) {
        logger.warn('fallBackWebhookUrl is not configured, skipping text notify forward.');
        return;
    }
    if (!content || typeof content !== 'string') return;

    await axios.post(STORE.fallBackWebhookUrl, {
        msgtype: 'text',
        text: {
            content: content
        }
    }, {
        headers: {
            'Content-Type': 'application/json'
        },
        timeout: 10000
    });
    logger.info(`Text notify sent to fallback webhook: ${content}`);
}

function getOpenClients() {
    if (!state.wsServer) return [];
    return Array.from(state.wsServer.clients).filter((client) => client.readyState === WebSocket.OPEN);
}

function sendToClients(payload, predicate = () => true) {
    const message = typeof payload === 'string' ? payload : JSON.stringify(payload);
    getOpenClients().forEach((client) => {
        if (predicate(client)) {
            client.send(message);
        }
    });
}

function sendToConnectedPageClients(payload) {
    sendToClients(payload, (client) => client.pageStatus === 'connected');
}

function applyExtensionStatus(status) {
    if (status === 'connected') {
        gui.updateExtensionStatus(gui.ExtensionStatus.CONNECTED);
        return;
    }
    if (status === 'login_needed') {
        gui.updateExtensionStatus(gui.ExtensionStatus.LOGIN_NEEDED);
        return;
    }
    if (status === 'other_page' || status === 'active') {
        gui.updateExtensionStatus(gui.ExtensionStatus.OTHER_PAGE);
        return;
    }
    gui.updateExtensionStatus(gui.ExtensionStatus.DISCONNECTED);
}

function sendConfigureIp(ip) {
    if (!ip) return;
    sendToConnectedPageClients({
        type: 'configure_ip',
        ip
    });
}

function sendConfigureTunnel(tunnelDomain) {
    if (!tunnelDomain) return;
    sendToConnectedPageClients({
        type: 'configure_tunnel',
        tunnelDomain,
        fullUrl: `https://${tunnelDomain}${CONFIG.wxApiUrl}`
    });
}

// WebSocket Server & Browser Communication
function startWsServer() {
    return new Promise((resolve, reject) => {
        try {
            state.wsServer = new WebSocketServer({ port: CONFIG.wsPort, host: CONFIG.wsHost });

            state.wsServer.on('listening', () => {
                logger.info(`WebSocket server started on ${CONFIG.wsHost}:${CONFIG.wsPort}`);
                resolve();
            });

            state.wsServer.on('error', (err) => {
                if (err.code === 'EADDRINUSE') {
                    reject(new Error(`Port ${CONFIG.wsPort} is already in use. Daemon might be already running.`));
                } else {
                    reject(err);
                }
            });

            state.wsServer.on('connection', (ws) => {
                logger.info('Browser extension connected.');
                state.browserConnected = true;
                ws.pageStatus = 'unknown';
                ws.send(JSON.stringify({
                    type: 'init',
                    ip: state.currentIp,
                    tunnelUrl: state.currentTunnelUrl
                }));

                ws.on('message', (message) => {
                    try {
                        const msg = JSON.parse(message);
                        switch (msg.type) {
                            case 'heartbeat':
                                state.lastBrowserHeartbeat = Date.now();
                                break;
                            case 'status':
                                ws.pageStatus = msg.status;
                                logger.info(`Browser status changed: ${msg.status} (URL: ${msg.url || 'unknown'})`);
                                applyExtensionStatus(msg.status);
                                if (msg.status === 'connected') {
                                    checkConfigMismatch();
                                }
                                break;
                            case 'config_success':
                                if (msg.configType === 'ip') {
                                    logger.info(`IP configuration success reported by client. Updating STORE: ${PERSISTENT_STATE.usingIp} -> ${msg.value}`);
                                    PERSISTENT_STATE.usingIp = msg.value;
                                    persistState();
                                    gui.updateIpConfigStatus(PERSISTENT_STATE.usingIp, state.currentIp);
                                } else if (msg.configType === 'tunnel') {
                                    logger.info(`Tunnel configuration success reported by client. Updating STORE: ${PERSISTENT_STATE.usingTunnelUrl} -> ${msg.domain}`);
                                    PERSISTENT_STATE.usingTunnelUrl = msg.domain;
                                    persistState();
                                    gui.updateTunnelConfigStatus(PERSISTENT_STATE.usingTunnelUrl, state.currentTunnelUrl);
                                }
                                break;
                            case 'config_error':
                                logger.warn(`Configuration error reported by client (${msg.configType}): ${msg.error}`);
                                if (msg.configType === 'tunnel') {
                                    gui.updateTunnelConfigError(msg.error);
                                }
                                break;
                            case 'login_screenshot':
                                sendFallbackLoginScreenshot(msg.base64).catch((error) => {
                                    logger.error(`Failed to send login screenshot: ${error.message}`);
                                });
                                break;
                            case 'login_qrcode_url':
                                handleLoginQrcodeUrl(msg.url).catch((error) => {
                                    logger.error(`Failed to handle QR code URL: ${error.message}`);
                                });
                                break;
                            case 'text_notify':
                                sendFallbackTextNotify(msg.text).catch((error) => {
                                    logger.error(`Failed to send text notify: ${error.message}`);
                                });
                                break;
                            default:
                                break;
                        }
                    } catch (e) {
                        logger.error('Error parsing WS message', e);
                    }
                });

                ws.on('close', () => {
                    logger.warn(`Browser extension disconnected. Last status: ${ws.pageStatus}`);
                    
                    // Delay disconnect handling to allow for page navigation (e.g. login -> app)
                    // If a new connection comes in within this window, we can ignore the disconnect.
                    setTimeout(() => {
                         // Check if there are other connected clients
                        const activeClients = getOpenClients();

                        if (activeClients.length === 0) {
                            state.browserConnected = false;
                            gui.updateExtensionStatus(gui.ExtensionStatus.DISCONNECTED);
                            
                            if (ws.pageStatus === 'closing') {
                                logger.info('Tab closed by user. Showing dialog.');
                                handleBrowserDisconnect();
                            } else if (ws.pageStatus === 'background') {
                                logger.warn('Connection lost while in background (Likely Frozen).');
                                handleBrowserDisconnect();
                            } else {
                                logger.warn('Connection lost unexpectedly (Crash or Network).');
                                handleBrowserDisconnect();
                            }
                        } else {
                            logger.info('Other clients still connected (or reconnected). Not showing disconnect dialog.');
                            const activeClient = activeClients[0];
                            if (activeClient.pageStatus) {
                                applyExtensionStatus(activeClient.pageStatus);
                            }
                        }
                    }, 2000);
                });
            });

        } catch (err) {
            reject(err);
        }
    });
}

// Cleanup function
function cleanup() {
    logger.info('Shutting down...');
    if (state.cloudflaredProcess) {
        state.cloudflaredProcess.kill();
    }
    if (state.wsServer) {
        state.wsServer.close();
    }
    process.exit();
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', () => {
    if (state.cloudflaredProcess) {
        state.cloudflaredProcess.kill();
    }
});

// Cloudflared Management
function startCloudflared() {
    if (state.cloudflaredProcess) {
        logger.info('Stopping existing cloudflared process...');
        state.cloudflaredProcess.kill();
    }

    logger.info(`Starting cloudflared with args: ${CONFIG.cloudflaredArgs.join(' ')}`);
    state.cloudflaredProcess = spawn(CONFIG.cloudflaredBin, CONFIG.cloudflaredArgs, {
        stdio: ['ignore', 'pipe', 'pipe'] // Capture stdout/stderr
    });

    state.cloudflaredProcess.stdout.on('data', (data) => {
        logger.debug(`Cloudflared stdout: ${data}`);
    });

    state.cloudflaredProcess.stderr.on('data', (data) => {
        logger.debug(`Cloudflared stderr: ${data}`);
    });

    state.cloudflaredProcess.on('error', (err) => {
        logger.error(`Failed to start cloudflared: ${err.message}`);
    });

    state.cloudflaredProcess.on('close', (code) => {
        logger.warn(`Cloudflared exited with code ${code}`);
        if (code === 1) {
            gui.updateTunnelStatus(gui.TunnelStatus.OFFLINE);
        }
        state.cloudflaredProcess = null;
    });
}

async function getTunnelUrl() {
    try {
        const response = await axios.get(CONFIG.metricsUrl);
        if (response.data && response.data.hostname) {
            return response.data.hostname;
        }
        logger.warn('Could not parse hostname from quicktunnel metrics', response.data);
        return null;
    } catch (error) {
        logger.error(`Failed to fetch tunnel URL: ${error.message}`);
        if (error.code === 'ECONNREFUSED') {
            gui.updateTunnelStatus(gui.TunnelStatus.OFFLINE);
            startCloudflared();
        }
        return null;
    }
}

async function checkTunnelHealth() {
    const tunnelUrl = await getTunnelUrl();
    
    if (!tunnelUrl) {
        logger.warn('Tunnel URL not available yet.');
        return;
    }

    if (tunnelUrl !== state.currentTunnelUrl) {
        logger.info(`Tunnel URL changed: ${state.currentTunnelUrl} -> ${tunnelUrl}`);
        state.currentTunnelUrl = tunnelUrl;
        notifyExtension();
        gui.updateTunnelConfigStatus(PERSISTENT_STATE.usingTunnelUrl, state.currentTunnelUrl);
    }

    // Check if the tunnel is actually reachable
    const CHECK_URL = ` https://${tunnelUrl}${CONFIG.wxApiUrl}`;
    try {
        await axios.get(CHECK_URL, { timeout: 5000 });
        logger.info(`Tunnel ${CHECK_URL} is reachable.`);
        gui.updateTunnelStatus(gui.TunnelStatus.ONLINE);
    } catch (error) {
        // Only restart if the error is ENOTFOUND (DNS resolution failed)
        if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
            logger.warn(`Tunnel ${CHECK_URL} is NOT reachable (ENOTFOUND/ECONNREFUSED): ${error.message}`);
            logger.info('Restarting cloudflared...');
            gui.updateTunnelStatus(gui.TunnelStatus.RESTARTING);
            startCloudflared();
        } else {
            logger.info(`Tunnel ${CHECK_URL} check failed with ${error.code || error.response?.status}, but considering it alive.`);
            gui.updateTunnelStatus(gui.TunnelStatus.ONLINE_UNSTABLE);
        }
    }
}

async function checkClawHealth() {
    try {
        await axios.get(CLAW_URL, {
            timeout: 3000,
            validateStatus: () => true
        });
        gui.updateClawStatus(gui.ClawStatus.ONLINE);
    } catch (error) {
        gui.updateClawStatus(gui.ClawStatus.OFFLINE);
    }
}

// IP Management
async function checkPublicIp() {
    try {
        const response = await axios.get(CONFIG.ipCheckUrl);
        // api.myip.la returns plain text IP usually, or JSON. Let's assume text or handle both.
        // If it's an object, try to find ip field. If string, use it.
        let ip = response.data;
        if (typeof ip === 'object') {
            ip = ip.ip || JSON.stringify(ip);
        }
        ip = String(ip).trim();

        if (state.currentIp && ip !== state.currentIp) {
            logger.info(`Public IP changed: ${state.currentIp} -> ${ip}`);
            state.currentIp = ip;
            notifyExtension();
            gui.updateIpConfigStatus(PERSISTENT_STATE.usingIp, state.currentIp);
        } else if (!state.currentIp) {
            state.currentIp = ip;
            logger.info(`Initial Public IP: ${ip}`);
            gui.updateIpConfigStatus(PERSISTENT_STATE.usingIp, state.currentIp);
        }
    } catch (error) {
        logger.error(`Failed to check public IP: ${error.message}`);
    }
}



function notifyExtension() {
    if (!state.wsServer) return;
    sendToClients({
        type: 'update',
        ip: state.currentIp,
        tunnelUrl: state.currentTunnelUrl
    });

    checkConfigMismatch();
}

function checkConfigMismatch() {
    if (!state.wsServer) return;

    if (state.currentIp && state.currentIp !== PERSISTENT_STATE.usingIp) {
        logger.info(`IP mismatch detected: STORE=${PERSISTENT_STATE.usingIp}, CURRENT=${state.currentIp}. Sending configure_ip.`);
        sendConfigureIp(state.currentIp);
    }

    if (state.currentTunnelUrl && state.currentTunnelUrl !== PERSISTENT_STATE.usingTunnelUrl) {
        logger.info(`Tunnel URL mismatch detected: STORE=${PERSISTENT_STATE.usingTunnelUrl}, CURRENT=${state.currentTunnelUrl}. Sending configure_tunnel.`);
        sendConfigureTunnel(state.currentTunnelUrl);
    }
}

function handleBrowserDisconnect() {
    // Logic to alert user or restart browser
    logger.warn('Browser disconnected! Please check the browser window.');
    
    // Show GUI Dialog
    gui.showDisconnectDialog({
        onReopenBrowser: async () => {
            logger.info('User requested to reopen browser.');
            await open(CONFIG.targetUrl);
        },
        onExit: () => {
            logger.info('User requested exit via dialog.');
            cleanup();
        }
    });

    console.log("ALERT: Browser disconnected! Please restart the browser or the daemon.");
}

// Main Startup Flow
async function main() {
    if (!STORE.wxAppId) {
        logger.error('wxAppId is not configured.');
        const action = await gui.showMissingWxAppIdDialog();
        const shouldOpenConfigDir = action === 'open' || action === 'unavailable';
        if (shouldOpenConfigDir) {
            try {
                fs.mkdirSync(STORE_DIR, { recursive: true });
                if (!fs.existsSync(CONFIG_FILE)) {
                    fs.writeFileSync(CONFIG_FILE, JSON.stringify(STORE_DEFAULTS, null, 2), 'utf8');
                }
                await openConfigDirectory(STORE_DIR);
                await new Promise((resolve) => setTimeout(resolve, 200));
            } catch (e) {
                logger.error(`Failed to open config directory: ${e.message}`);
            }
        }
        gui.closeGui();
        process.exitCode = shouldOpenConfigDir ? 0 : 1;
        return;
        
    }

    // Initialize GUI
    const guiInitialized = await gui.initGui({
        onExit: () => {
            logger.info('User requested exit via tray.');
            cleanup();
        },
        onIpConfigClick: () => {
            logger.info('User requested IP config via tray.');
            if (state.currentIp) {
                sendConfigureIp(state.currentIp);
            }
        },
        onTunnelConfigClick: () => {
            logger.info('User requested Tunnel config via tray.');
            if (state.currentTunnelUrl) {
                sendConfigureTunnel(state.currentTunnelUrl);
            }
        },
        onRestartCloudflaredClick: () => {
            logger.info('User requested Cloudflared restart via tray.');
            gui.updateTunnelStatus(gui.TunnelStatus.RESTARTING);
            startCloudflared();
        }
    });

    if (guiInitialized) {
        logger.info('GUI initialized successfully.');
    } else {
        logger.warn('GUI initialization failed or skipped. Running in headless mode.');
    }

    try {
        await startWsServer();
    } catch (err) {
        logger.error(err.message);
        console.error(err.message);
        process.exit(1);
    }
    
    startCloudflared();
    
    // Initial checks
    await checkPublicIp();
    await checkClawHealth();
    
    // Start periodic checks
    setInterval(checkPublicIp, CONFIG.checkInterval);
    setInterval(checkTunnelHealth, CONFIG.checkInterval);
    setInterval(checkClawHealth, CONFIG.checkInterval);
    
    // Open Browser
    // Check if extension is already connected within a short timeout
    logger.info('Waiting for extension connection...');
    const connectionTimeout = 2000; // 2 seconds
    const checkStartTime = Date.now();
    
    const waitForConnection = new Promise((resolve) => {
        // If already connected
        if (state.browserConnected) {
            resolve(true);
            return;
        }

        const interval = setInterval(() => {
            if (state.browserConnected) {
                clearInterval(interval);
                resolve(true);
            } else if (Date.now() - checkStartTime > connectionTimeout) {
                clearInterval(interval);
                resolve(false);
            }
        }, 200);
    });

    const connected = await waitForConnection;

    if (connected) {
        logger.info('Extension already connected. Skipping browser launch.');
    } else {
        logger.info(`Extension not connected within ${connectionTimeout}ms. Opening browser at ${CONFIG.targetUrl}`);
        await open(CONFIG.targetUrl); 
    } 
}

main().catch(err => {
    logger.error('Fatal error:', err);
    gui.closeGui();
    process.exitCode = 1;
});
