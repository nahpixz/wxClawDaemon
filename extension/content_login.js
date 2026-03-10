console.log('WxClaw Helper Login Script Loaded');

const WS_URL = 'ws://127.0.0.1:18790';
let ws;
let retryInterval = 5000;
let isConnecting = false;
let lastQrcodeSentAt = 0;
let lastReloadAt = 0;
let captureRetryTimer = null;
let reloadCheckTimer = null;

function sendTextNotify(content) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'text_notify',
            text: content
        }));
    }
}

function getIframeDocument() {
    const iframe = document.querySelector('#wx_reg > iframe');
    return iframe ? (iframe.contentDocument || iframe.contentWindow.document) : null;
}

function checkQrcodeAndCapture() {
    const now = Date.now();
    // Throttle: only check/send every 60s unless reset
    // if (now - lastQrcodeSentAt < 60000) return;

    // let img = document.querySelector('.qrcode_login_img.js_qrcode_img');
    // if (!img) {
    //     const doc = getIframeDocument();
    //     if (doc) img = doc.querySelector('.qrcode_login_img.js_qrcode_img');
    // }
    const doc = getIframeDocument();
    if (doc) img = doc.querySelector('.qrcode_login_img.js_qrcode_img');

    if (img && img.src && !img.src.includes('login_qrcode')) { // Ensure src is not empty or just a placeholder
        // Found valid QR code, send src
        console.warn('checkQrcodeAndCapture: Found valid src', img.src);
        // const qrcode = img.src.replace('login_qrcode','qrcode')
        sendLoginQrcode(img.src);
        // Stop checking once sent (until next explicit trigger or timeout)
        if (captureRetryTimer) {
            clearInterval(captureRetryTimer);
            captureRetryTimer = null;
        }
    } else {
        // Keep checking
        if (!captureRetryTimer) {
            captureRetryTimer = setInterval(checkQrcodeAndCapture, 1000);
        }
    }
}

function checkReload() {
    const now = Date.now();
    // Prevent spamming reload: at most once every 5 seconds
    if (now - lastReloadAt < 5000) return;

    let reloadLink = document.querySelector('.qrcode_login_reload');
    if (!reloadLink) {
        const doc = getIframeDocument();
        if (doc) reloadLink = doc.querySelector('.qrcode_login_reload');
    }

    if (reloadLink && reloadLink.offsetParent !== null) { // Visible
        console.log('QR code expired, clicking reload...');
        lastReloadAt = now;
        
        // Use script injection to bypass CSP for javascript: links or inline handlers
        // Must use src attribute with web_accessible_resources to bypass inline script CSP
        const script = document.createElement('script');
        script.src = chrome.runtime.getURL('inject_click.js');
        script.onload = function() {
            this.remove();
        };
        (document.head || document.documentElement).appendChild(script);

        sendTextNotify('二维码已过期，正在刷新...');
        
        // After reload, start checking for QR code again immediately
        lastQrcodeSentAt = 0; // Reset timer to allow immediate send
        if (captureRetryTimer) clearInterval(captureRetryTimer);
        captureRetryTimer = setInterval(checkQrcodeAndCapture, 1000);
    }
}

function sendLoginQrcode(src) {
    const now = Date.now();
    if (now - lastQrcodeSentAt < 60000) return;
    
    lastQrcodeSentAt = now;
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'login_qrcode_url',
            url: src
        }));
    }
}

function connect() {
    if (isConnecting || (ws && ws.readyState === WebSocket.OPEN)) return;
    isConnecting = true;

    try {
        ws = new WebSocket(WS_URL);
    } catch (e) {
        console.error("Failed to create WebSocket:", e);
        isConnecting = false;
        setTimeout(connect, retryInterval);
        return;
    }

    ws.onopen = () => {
        console.log('Connected to Daemon from Login Page');
        isConnecting = false;
        
        // Report login_needed status
        ws.send(JSON.stringify({ type: 'status', status: 'login_needed', url: window.location.href }));
        
        sendTextNotify('检测到未登录状态，请注意：管理后台登出或网络变动可能导致连接断开。');
        
        checkQrcodeAndCapture();
        
        // Start reload checker
        // if (!reloadCheckTimer) {
        //     reloadCheckTimer = setInterval(checkReload, 2000);
        // }

        // Heartbeat
        setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'heartbeat' }));
            }
        }, 10000);
    };

    ws.onmessage = (event) => {
        // Login page might not need to handle updates, but we log it
        try {
            const message = JSON.parse(event.data);
            console.log('Received message:', message);
        } catch (e) {
            console.error('Error parsing message', e);
        }
    };

    ws.onclose = () => {
        console.log('Disconnected from Daemon. Reconnecting in 5s...');
        isConnecting = false;
        ws = null;
        setTimeout(connect, retryInterval);
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
    };
}

// Lifecycle Hooks
document.addEventListener('visibilitychange', () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    
    if (document.visibilityState === 'hidden') {
        ws.send(JSON.stringify({ type: 'status', status: 'background' }));
    } else {
        ws.send(JSON.stringify({ type: 'status', status: 'login_needed', url: window.location.href }));
        checkQrcodeAndCapture();
    }
});

window.addEventListener('pagehide', () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'status', status: 'closing' }));
    }
});

// Start connection
connect();
