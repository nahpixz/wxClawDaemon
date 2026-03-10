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
let statusAction = null;
let clawStatusAction = null;
let extStatusAction = null;
let ipConfigAction = null;
let tunnelConfigAction = null;
let exitAction = null;
let disconnectDialog = null;
let disconnectLabel = null;

// Track current statuses for combination logic
let currentClawStatus = 'OFFLINE'; // Default to OFFLINE
let currentTunnelStatus = 'INIT'; // Default to INIT

// Cache last arguments for re-triggering updates
let lastIpConfigArgs = null;
let lastTunnelConfigArgs = null;

// Load nodegui dynamically
async function loadNodegui() {
    try {
        // Try to import from default location
        nodegui = await import('@nodegui/nodegui');
        return true;
    } catch (e) {
        // If that fails, and we are not running with qode, it's expected.
        // But if user claims it is installed, maybe it's a path issue or qode issue.
        console.warn("GUI: @nodegui/nodegui load failed.", e.message);
        return false;
    }
}

export async function initGui(callbacks) {
    if (!await loadNodegui()) return false;

    const { 
        QApplication, QSystemTrayIcon, QMenu, QAction, QIcon, 
        QDialog, QLabel, QPushButton, QGridLayout, QWidget, QPixmap,
        WindowModality, AlignmentFlag 
    } = nodegui;

    try {
        qApp = QApplication.instance();
        qApp.setQuitOnLastWindowClosed(false);

        // Icon Setup
        // We need a real icon file for the tray to show up on Windows
        const iconPath = path.resolve(__dirname, './assets/icon.png');
        if (!fs.existsSync(iconPath)) {
            // Ensure assets dir exists
            const assetsDir = path.dirname(iconPath);
            if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });
            // We can't easily generate a valid PNG here without external libs or buffers.
            // But we can try to use a system icon or just warn.
            console.warn(`GUI: Icon file not found at ${iconPath}. Tray might not be visible.`);
        }
        
        const icon = new QIcon(iconPath);

        // Tray Setup
        tray = new QSystemTrayIcon();
        tray.setIcon(icon);
        tray.setToolTip('OpenClaw微信守护进程');

        // Context Menu
        contextMenu = new QMenu();
        // Set larger font for the menu
        contextMenu.setStyleSheet(`
            QMenu {
                font-size: 14px;
                padding: 5px;
            }
            QMenu::item {
                padding: 5px 20px;
            }
        `);
        
        statusAction = new QAction();
        statusAction.setText('⚪ 隧道状态: 初始化中...');
        statusAction.setEnabled(false);

        clawStatusAction = new QAction();
        clawStatusAction.setText('⚪ 龙虾状态: 初始化中...');
        clawStatusAction.setEnabled(false);
        
        extStatusAction = new QAction();
        extStatusAction.setText('🔴 企业微信后台: 未连接');
        extStatusAction.setEnabled(false);

        ipConfigAction = new QAction();
        ipConfigAction.setText('⚪ 发送: 出口IP获取中...');
        ipConfigAction.setEnabled(false); // Initially disabled or enabled based on logic
        ipConfigAction.addEventListener('triggered', () => {
            if (callbacks.onIpConfigClick) callbacks.onIpConfigClick();
        });

        tunnelConfigAction = new QAction();
        tunnelConfigAction.setText('⚪ 接受: URL获取中...');
        tunnelConfigAction.setEnabled(false);
        tunnelConfigAction.addEventListener('triggered', () => {
            if (callbacks.onTunnelConfigClick) callbacks.onTunnelConfigClick();
        });
        
        exitAction = new QAction();
        exitAction.setText('退出');
        exitAction.addEventListener('triggered', () => {
            callbacks.onExit();
        });

        contextMenu.addAction(statusAction);
        contextMenu.addAction(clawStatusAction);
        contextMenu.addAction(extStatusAction);
        contextMenu.addSeparator();
        contextMenu.addAction(ipConfigAction);
        contextMenu.addAction(tunnelConfigAction);
        contextMenu.addSeparator();
        contextMenu.addAction(exitAction);

        tray.setContextMenu(contextMenu);
        tray.show();

        // Keep references to prevent GC
        global.gui = { tray, contextMenu, qApp };

        return true;
    } catch (e) {
        console.error("GUI: Initialization failed:", e);
        return false;
    }
}

export const TunnelStatus = {
    INIT: 'INIT',
    ONLINE: 'ONLINE',
    ONLINE_UNSTABLE: 'ONLINE_UNSTABLE',
    OFFLINE: 'OFFLINE',
    RESTARTING: 'RESTARTING'
};

export function updateTunnelStatus(status) {
    if (!statusAction) return;
    
    currentTunnelStatus = status; // Update global state
    
    // Trigger updates for dependent actions
    if (lastIpConfigArgs) {
        // IP config might not strictly depend on tunnel status, but let's refresh just in case logic changes
        // Currently updateIpConfigStatus only depends on currentClawStatus and IP mismatch.
        // So we might skip this unless required.
        // But user said: "tunnelConfigAction的indicator受statusAction的状态影响"
        // So we MUST refresh tunnel config.
    }
    
    if (lastTunnelConfigArgs) {
        updateTunnelConfigStatus(...lastTunnelConfigArgs);
    }

    let indicator = '⚪';
    let text = '初始化中...';

    switch (status) {
        case TunnelStatus.ONLINE:
            indicator = '🟢';
            text = '在线';
            break;
        case TunnelStatus.ONLINE_UNSTABLE:
            indicator = '🟡';
            text = '在线 (不稳定)';
            break;
        case TunnelStatus.OFFLINE:
            indicator = '🔴';
            text = '离线';
            break;
        case TunnelStatus.RESTARTING:
            indicator = '🟡';
            text = '重启中...';
            break;
        case TunnelStatus.INIT:
        default:
            indicator = '⚪';
            text = '初始化中...';
            break;
    }

    statusAction.setText(`${indicator} 隧道状态: ${text}`);
}

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

export function updateClawStatus(status) {
    if (!clawStatusAction) return;
    currentClawStatus = status; // Track it
    
    // Trigger updates for dependent actions
    if (lastIpConfigArgs) {
        updateIpConfigStatus(...lastIpConfigArgs);
    }
    if (lastTunnelConfigArgs) {
        updateTunnelConfigStatus(...lastTunnelConfigArgs);
    }

    let indicator = '🔴';
    let text = '离线';
    if (status === ClawStatus.ONLINE) {
        indicator = '🟢';
        text = '在线';
    }
    clawStatusAction.setText(`${indicator} 龙虾状态: ${text}`);
}

export function updateExtensionStatus(status) {
    if (!extStatusAction) return;
    
    let indicator = '🔴';
    let text = '未连接';

    switch (status) {
        case ExtensionStatus.CONNECTED:
            indicator = '🟢';
            text = '已连接';
            break;
        case ExtensionStatus.LOGIN_NEEDED:
            indicator = '🟠';
            text = '未登录';
            break;
        case ExtensionStatus.OTHER_PAGE:
            indicator = '🟠';
            text = '已连接 (非应用页)';
            break;
        case ExtensionStatus.DISCONNECTED:
        default:
            indicator = '🔴';
            text = '未连接';
            break;
    }

    const statusText = `${indicator} 企业微信后台: ${text}`;
    extStatusAction.setText(statusText);
    console.log(`GUI: Updated extension status to ${statusText}`);
}

export function updateIpConfigStatus(usingIp, currentIp) {
    if (!ipConfigAction) return;
    
    // Cache args for reactive updates
    lastIpConfigArgs = [usingIp, currentIp];

    // Logic: 
    // 1. If Claw is OFFLINE -> IP Config Indicator is RED
    // 2. If IP Mismatch -> IP Config Indicator is RED
    // 3. Otherwise GREEN

    let indicator = '🟢';
    if (currentClawStatus === ClawStatus.OFFLINE) {
        indicator = '🔴';
    }

    if (usingIp === currentIp) {
        // Mismatch is false (usingIp == currentIp)
        // If Claw is OFFLINE, still RED.
        ipConfigAction.setText(`${indicator} 发送: ${usingIp}`);
        ipConfigAction.setEnabled(false);
    } else {
        // Mismatch is true
        ipConfigAction.setText(`🔴 发送: 未信任本地IP ${currentIp}`);
        ipConfigAction.setEnabled(true);
    }
}

export function updateTunnelConfigStatus(usingTunnelUrl, currentTunnelUrl) {
    if (!tunnelConfigAction) return;

    // Cache args for reactive updates
    lastTunnelConfigArgs = [usingTunnelUrl, currentTunnelUrl];
    
    // Logic:
    // 1. If Claw is OFFLINE -> Tunnel Config Indicator is RED
    // 2. If Tunnel Status is NOT ONLINE (INIT, OFFLINE, RESTARTING, UNSTABLE) -> Tunnel Config Indicator is RED
    // 3. If URL Mismatch -> Tunnel Config Indicator is RED
    // 4. Otherwise GREEN

    let indicator = '🟢';
    
    // Check dependencies
    const isTunnelHealthy = (currentTunnelStatus === TunnelStatus.ONLINE); // Only ONLINE is healthy enough for config indicator? 
    // User said: "ONLINE_UNSTABLE和RESTARTING也视为tunnelConfigAction离线" -> So yes, only ONLINE is green.
    
    if (currentClawStatus === ClawStatus.OFFLINE || !isTunnelHealthy) {
        indicator = '🔴';
    }

    if (usingTunnelUrl === currentTunnelUrl) {
        let text = usingTunnelUrl.split('.')[0];
        // If status is not green, we should probably indicate why, or just show red dot.
        // User requirement: "indicator均受到龙虾状态影响同步"
        // User requirement: "ONLINE_UNSTABLE和RESTARTING也视为tunnelConfigAction离线"
        tunnelConfigAction.setText(`${indicator} 接收: ${text}`);
        tunnelConfigAction.setEnabled(false);
    } else {
        let text = currentTunnelUrl.split('.')[0];
        tunnelConfigAction.setText(`🔴 接收: URL待更新 ${text}`);
        tunnelConfigAction.setEnabled(true);
    }
}

export function updateTunnelConfigError(errorMsg) {
    if (!tunnelConfigAction) return;
    tunnelConfigAction.setText(`🔴 接收: ${errorMsg}`);
    tunnelConfigAction.setEnabled(true);
}

export async function showMissingWxAppIdDialog() {
    if (!await loadNodegui()) return 'unavailable';
    const { QApplication, QDialog, QLabel, QPushButton, QGridLayout, AlignmentFlag, QIcon } = nodegui;
    qApp = QApplication.instance();
    qApp.setQuitOnLastWindowClosed(false);
    return new Promise((resolve) => {
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            resolve(result);
        };
        const dialog = new QDialog();
        dialog.setWindowTitle('OpenClaw微信守护进程');
        dialog.setModal(true);
        const iconPath = path.resolve(__dirname, './assets/icon.png');
        if (fs.existsSync(iconPath)) {
            const icon = new QIcon(iconPath);
            dialog.setWindowIcon(icon);
        }
        const layout = new QGridLayout();
        dialog.setLayout(layout);
        const label = new QLabel();
        label.setText('企业微信应用ID未配置');
        if (AlignmentFlag) {
            label.setAlignment(AlignmentFlag.AlignCenter);
        }
        const btnOpen = new QPushButton();
        btnOpen.setText('打开配置文件夹');
        btnOpen.addEventListener('clicked', () => {
            finish('open');
            dialog.close();
        });
        const btnExit = new QPushButton();
        btnExit.setText('退出');
        btnExit.addEventListener('clicked', () => {
            finish('exit');
            dialog.close();
        });
        layout.addWidget(label, 0, 0, 1, 2);
        layout.addWidget(btnOpen, 1, 0);
        layout.addWidget(btnExit, 1, 1);
        dialog.setStyleSheet(`
            QLabel { font-size: 16px; margin-bottom: 20px; font-weight: bold; }
            QPushButton { font-size: 13px; padding: 10px 20px; min-width: 150px; }
        `);
        dialog.addEventListener('close', () => {
            finish('exit');
        });
        dialog.show();
        dialog.raise();
        dialog.activateWindow();
    });
}

export function showDisconnectDialog(callbacks) {
    if (!nodegui) return;
    const { QDialog, QLabel, QPushButton, QGridLayout, WindowModality, AlignmentFlag, QIcon } = nodegui;

    if (disconnectDialog) {
        disconnectDialog.show();
        disconnectDialog.raise();
        disconnectDialog.activateWindow();
        return;
    }

    disconnectDialog = new QDialog();
    disconnectDialog.setWindowTitle('OpenClaw微信守护进程');
    
    // QDialog inherits from QWidget, but setWindowModality might need to be called on the widget/window level 
    // or nodegui API differs.
    // In nodegui docs, setWindowModality is a method of QWidget. QDialog extends QWidget.
    // However, if it says "is not a function", maybe it's missing in this version bindings.
    // We can try `setModal(true)` which is specific to QDialog.
    disconnectDialog.setModal(true);
    
    // If WindowModality is still needed, we might need to check if it's available.
    // But setModal(true) is usually enough for ApplicationModal behavior in QDialog.
    /*
    if (WindowModality) {
        disconnectDialog.setWindowModality(WindowModality.ApplicationModal);
    }
    */
    
    // Set Icon
    const iconPath = path.resolve(__dirname, './assets/icon.png');
    if (fs.existsSync(iconPath)) {
        const icon = new QIcon(iconPath);
        disconnectDialog.setWindowIcon(icon);
    }

    // Simple Layout
    const layout = new QGridLayout();
    disconnectDialog.setLayout(layout);

    const label = new QLabel();
    label.setText('企业微信后台关闭,无法及时设置本机IP为可信IP,微信将无法与openclaw通信。');
    // If AlignmentFlag is available, use it. Otherwise skip alignment or use style.
    if (AlignmentFlag) {
        label.setAlignment(AlignmentFlag.AlignCenter);
    } else {
        // Fallback or ignore
    }

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

    // Style
    disconnectDialog.setStyleSheet(`
        QLabel { font-size: 16px; margin-bottom: 20px; font-weight: bold; }
        QPushButton { font-size: 13px; padding: 10px 20px; min-width: 150px; }
    `);

    disconnectDialog.show();
    disconnectDialog.raise();
    disconnectDialog.activateWindow();
    
    // Keep reference
    global.disconnectDialog = disconnectDialog;
}

export function closeGui() {
    if (qApp) {
        qApp.quit();
    }
}
