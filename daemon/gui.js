import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Helper for ESM directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let nodegui = null;
let qApp = null;
let tray = null;
let contextMenu = null;
let disconnectDialog = null;

// Enums
export const TunnelStatus = {
    INIT: 'INIT',
    ONLINE: 'ONLINE',
    ONLINE_UNSTABLE: 'ONLINE_UNSTABLE',
    OFFLINE: 'OFFLINE',
    RESTARTING: 'RESTARTING'
};

export const ExtensionStatus = {
    CONNECTED: 'CONNECTED',
    DISCONNECTED: 'DISCONNECTED',
    LOGIN_NEEDED: 'LOGIN_NEEDED',
    OTHER_PAGE: 'OTHER_PAGE'
};

export const ClawStatus = {
    ONLINE: 'ONLINE',
    OFFLINE: 'OFFLINE'
};

// Global Reactive State
const state = {
    claw: { status: ClawStatus.OFFLINE, indicator: '⚪', msg: '初始化中...' },
    tunnel: { status: TunnelStatus.INIT, indicator: '⚪', msg: '初始化中...' },
    extension: { status: ExtensionStatus.DISCONNECTED, indicator: '🔴', msg: '未连接' },
    ipConfig: { using: null, current: null },
    tunnelConfig: { using: null, current: null, error: null }
};

// --- Status Item Abstraction ---
class StatusItem {
    constructor(label, logicFn, onClick) {
        this.label = label;
        this.logicFn = logicFn; // Function returning { indicator, msg, enabled }
        this.action = null; // Created in init
        this.onClick = onClick;
    }

    init(QAction) {
        this.action = new QAction();
        if (this.onClick) {
            this.action.addEventListener('triggered', this.onClick);
        }
        this.update();
        return this.action;
    }

    update() {
        if (!this.action) return;
        const { indicator, msg, enabled } = this.logicFn(state);
        // Format: "${indicator} ${label}: ${msg}"
        this.action.setText(`${indicator} ${this.label}: ${msg}`);
        this.action.setEnabled(!!enabled);
    }
}

// --- Menu Items Definitions ---
const items = {
    tunnelStatus: new StatusItem('隧道状态', (s) => ({
        indicator: s.tunnel.indicator,
        msg: s.tunnel.msg,
        enabled: false
    })),

    clawStatus: new StatusItem('龙虾状态', (s) => ({
        indicator: s.claw.indicator,
        msg: s.claw.msg,
        enabled: false
    })),

    extensionStatus: new StatusItem('企业微信后台', (s) => ({
        indicator: s.extension.indicator,
        msg: s.extension.msg,
        enabled: false
    })),

    ipConfig: new StatusItem('发送', (s) => {
        const { using, current } = s.ipConfig;
        if (!using && !current) return { indicator: '⚪', msg: '出口IP获取中...', enabled: false };

        const mismatch = using !== current;
        const isClawOffline = s.claw.status === ClawStatus.OFFLINE;
        
        // Indicator Logic
        let indicator = '🟢';
        if (isClawOffline) indicator = '🔴';
        
        // Message Logic
        let msg = using || current;
        if (mismatch) {
            indicator = '🔴'; // Override if mismatch
            msg = `未信任本地IP ${current}`;
        }

        return {
            indicator,
            msg,
            enabled: mismatch // Enabled only if mismatch
        };
    }),

    tunnelConfig: new StatusItem('接收', (s) => {
        const { using, current, error } = s.tunnelConfig;
        
        if (error) {
            return { indicator: '🔴', msg: error, enabled: true };
        }
        if (!using && !current) return { indicator: '⚪', msg: 'URL获取中...', enabled: false };

        const mismatch = using !== current;
        const isClawOffline = s.claw.status === ClawStatus.OFFLINE;
        const isTunnelUnhealthy = s.tunnel.status !== TunnelStatus.ONLINE;

        // Indicator Logic
        let indicator = '🟢';
        if (isClawOffline || isTunnelUnhealthy) indicator = '🔴';

        // Message Logic
        let msg = (using || current || '').split('.')[0];
        if (mismatch) {
            indicator = '🔴'; // Override if mismatch
            msg = `URL待更新 ${current ? current.split('.')[0] : ''}`;
        }

        return {
            indicator,
            msg,
            enabled: mismatch || !!error // Enable if mismatch or error
        };
    })
};

// --- Helper Functions ---
function updateAllItems() {
    Object.values(items).forEach(item => item.update());
}

// --- Exported API (Adapter to new State) ---

async function loadNodegui() {
    try {
        nodegui = await import('@nodegui/nodegui');
        return true;
    } catch (e) {
        console.warn("GUI: @nodegui/nodegui load failed.", e.message);
        return false;
    }
}

export async function initGui(callbacks) {
    if (!await loadNodegui()) return false;

    const { 
        QApplication, QSystemTrayIcon, QMenu, QAction, QIcon, 
        QDialog, QLabel, QPushButton, QGridLayout, AlignmentFlag 
    } = nodegui;

    try {
        qApp = QApplication.instance();
        qApp.setQuitOnLastWindowClosed(false);

        // Icon
        const iconPath = path.resolve(__dirname, './assets/icon.png');
        if (!fs.existsSync(iconPath)) {
            const assetsDir = path.dirname(iconPath);
            if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });
            console.warn(`GUI: Icon file not found at ${iconPath}. Tray might not be visible.`);
        }
        const icon = new QIcon(iconPath);

        // Tray
        tray = new QSystemTrayIcon();
        tray.setIcon(icon);
        tray.setToolTip('OpenClaw微信守护进程');

        // Menu
        contextMenu = new QMenu();
        contextMenu.setStyleSheet(`
            QMenu { font-size: 14px; padding: 5px; }
            QMenu::item { padding: 5px 20px; }
        `);

        // Bind Callbacks
        items.ipConfig.onClick = () => callbacks.onIpConfigClick && callbacks.onIpConfigClick();
        items.tunnelConfig.onClick = () => callbacks.onTunnelConfigClick && callbacks.onTunnelConfigClick();
        
        // Initialize Actions
        contextMenu.addAction(items.tunnelStatus.init(QAction));
        contextMenu.addAction(items.clawStatus.init(QAction));
        contextMenu.addAction(items.extensionStatus.init(QAction));
        contextMenu.addSeparator();
        contextMenu.addAction(items.ipConfig.init(QAction));
        contextMenu.addAction(items.tunnelConfig.init(QAction));
        contextMenu.addSeparator();

        const exitAction = new QAction();
        exitAction.setText('退出');
        exitAction.addEventListener('triggered', () => callbacks.onExit && callbacks.onExit());
        contextMenu.addAction(exitAction);

        tray.setContextMenu(contextMenu);
        tray.show();

        global.gui = { tray, contextMenu, qApp };
        return true;
    } catch (e) {
        console.error("GUI: Initialization failed:", e);
        return false;
    }
}

export function updateTunnelStatus(status) {
    state.tunnel.status = status;
    
    let indicator = '⚪';
    let msg = '初始化中...';

    switch (status) {
        case TunnelStatus.ONLINE:
            indicator = '🟢'; msg = '在线'; break;
        case TunnelStatus.ONLINE_UNSTABLE:
            indicator = '🟡'; msg = '在线 (不稳定)'; break;
        case TunnelStatus.OFFLINE:
            indicator = '🔴'; msg = '离线'; break;
        case TunnelStatus.RESTARTING:
            indicator = '🟡'; msg = '重启中...'; break;
        case TunnelStatus.INIT:
        default:
            indicator = '⚪'; msg = '初始化中...'; break;
    }
    state.tunnel.indicator = indicator;
    state.tunnel.msg = msg;
    
    updateAllItems();
}

export function updateClawStatus(status) {
    state.claw.status = status;
    
    let indicator = '🔴';
    let msg = '离线';
    if (status === ClawStatus.ONLINE) {
        indicator = '🟢'; msg = '在线';
    }
    state.claw.indicator = indicator;
    state.claw.msg = msg;

    updateAllItems();
}

export function updateExtensionStatus(status) {
    state.extension.status = status;

    let indicator = '🔴';
    let msg = '未连接';

    switch (status) {
        case ExtensionStatus.CONNECTED:
            indicator = '🟢'; msg = '已连接'; break;
        case ExtensionStatus.LOGIN_NEEDED:
            indicator = '🟠'; msg = '未登录'; break;
        case ExtensionStatus.OTHER_PAGE:
            indicator = '🟠'; msg = '已连接 (非应用页)'; break;
        case ExtensionStatus.DISCONNECTED:
        default:
            indicator = '🔴'; msg = '未连接'; break;
    }
    state.extension.indicator = indicator;
    state.extension.msg = msg;

    updateAllItems();
}

export function updateIpConfigStatus(usingIp, currentIp) {
    state.ipConfig.using = usingIp;
    state.ipConfig.current = currentIp;
    updateAllItems();
}

export function updateTunnelConfigStatus(usingTunnelUrl, currentTunnelUrl) {
    state.tunnelConfig.using = usingTunnelUrl;
    state.tunnelConfig.current = currentTunnelUrl;
    state.tunnelConfig.error = null; // Clear error on update
    updateAllItems();
}

export function updateTunnelConfigError(errorMsg) {
    state.tunnelConfig.error = errorMsg;
    updateAllItems();
}

export async function showMissingWxAppIdDialog() {
    if (!await loadNodegui()) return 'unavailable';
    const { QApplication, QDialog, QLabel, QPushButton, QGridLayout, AlignmentFlag, QIcon } = nodegui;
    qApp = QApplication.instance();
    qApp.setQuitOnLastWindowClosed(false);
    return new Promise((resolve) => {
        const dialog = new QDialog();
        dialog.setWindowTitle('OpenClaw微信守护进程');
        dialog.setModal(true);
        const iconPath = path.resolve(__dirname, './assets/icon.png');
        if (fs.existsSync(iconPath)) dialog.setWindowIcon(new QIcon(iconPath));
        
        const layout = new QGridLayout();
        dialog.setLayout(layout);
        
        const label = new QLabel();
        label.setText('企业微信应用ID未配置');
        if (AlignmentFlag) label.setAlignment(AlignmentFlag.AlignCenter);
        
        const btnOpen = new QPushButton();
        btnOpen.setText('打开配置文件夹');
        btnOpen.addEventListener('clicked', () => { dialog.close(); resolve('open'); });
        
        const btnExit = new QPushButton();
        btnExit.setText('退出');
        btnExit.addEventListener('clicked', () => { dialog.close(); resolve('exit'); });
        
        layout.addWidget(label, 0, 0, 1, 2);
        layout.addWidget(btnOpen, 1, 0);
        layout.addWidget(btnExit, 1, 1);
        dialog.setStyleSheet(`
            QLabel { font-size: 16px; margin-bottom: 20px; font-weight: bold; }
            QPushButton { font-size: 13px; padding: 10px 20px; min-width: 150px; }
        `);
        dialog.addEventListener('close', () => resolve('exit'));
        dialog.show();
        dialog.raise();
        dialog.activateWindow();
    });
}

export function showDisconnectDialog(callbacks) {
    if (!nodegui) return;
    const { QDialog, QLabel, QPushButton, QGridLayout, AlignmentFlag, QIcon } = nodegui;

    if (disconnectDialog) {
        disconnectDialog.show();
        disconnectDialog.raise();
        disconnectDialog.activateWindow();
        return;
    }

    disconnectDialog = new QDialog();
    disconnectDialog.setWindowTitle('OpenClaw微信守护进程');
    disconnectDialog.setModal(true);
    
    const iconPath = path.resolve(__dirname, './assets/icon.png');
    if (fs.existsSync(iconPath)) disconnectDialog.setWindowIcon(new QIcon(iconPath));

    const layout = new QGridLayout();
    disconnectDialog.setLayout(layout);

    const label = new QLabel();
    label.setText('企业微信后台关闭,无法及时设置本机IP为可信IP,微信将无法与openclaw通信。');
    if (AlignmentFlag) label.setAlignment(AlignmentFlag.AlignCenter);

    const btnReopen = new QPushButton();
    btnReopen.setText('重新打开企业微信后台');
    btnReopen.addEventListener('clicked', () => {
        callbacks.onReopenBrowser();
        disconnectDialog.close();
    });

    const btnExit = new QPushButton();
    btnExit.setText('退出守护进程');
    btnExit.addEventListener('clicked', () => {
        callbacks.onExit();
        disconnectDialog.close();
    });

    layout.addWidget(label, 0, 0, 1, 2);
    layout.addWidget(btnReopen, 1, 0);
    layout.addWidget(btnExit, 1, 1);

    disconnectDialog.setStyleSheet(`
        QLabel { font-size: 16px; margin-bottom: 20px; font-weight: bold; }
        QPushButton { font-size: 13px; padding: 10px 20px; min-width: 150px; }
    `);

    disconnectDialog.show();
    disconnectDialog.raise();
    disconnectDialog.activateWindow();
    
    global.disconnectDialog = disconnectDialog;
}

export function closeGui() {
    if (qApp) qApp.quit();
}
