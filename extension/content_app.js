console.log('WxClaw Helper App Script Loaded');

const WS_URL = 'ws://127.0.0.1:18790';
const TARGET_APP_PATH = '/wework_admin/frame#/apps/modApiApp';
let ws;
let retryInterval = 5000;
let isConnecting = false;

function isAppUrl(url) {
    return url.includes(TARGET_APP_PATH);
}

function connect() {
    // If not in app scope, do not connect
    if (!isAppUrl(window.location.href)) {
        console.log('Not in app scope, skipping connection');
        return;
    }

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
        console.log('Connected to Daemon from App Page');
        isConnecting = false;
        
        // Report connected status
        ws.send(JSON.stringify({ type: 'status', status: 'connected', url: window.location.href }));

        // Heartbeat
        setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'heartbeat' }));
            }
        }, 10000);
    };

    ws.onmessage = async (event) => {
        try {
            const message = JSON.parse(event.data);
            if (message.type === 'update' || message.type === 'init') {
                const { ip, tunnelUrl } = message;
                console.log(`Received update: IP=${ip}, Tunnel=${tunnelUrl}`);
                executeCustomScript(ip, tunnelUrl);
            } else if (message.type === 'configure_ip') {
                console.log('Received configure_ip command', message.ip);
                await configureIp(message.ip);
            } else if (message.type === 'configure_tunnel') {
                console.log('Received configure_tunnel command', message.fullUrl);
                await configureTunnel(message.fullUrl, message.tunnelDomain);
            }
        } catch (e) {
            console.error('Error handling message', e);
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
    if (!ws || ws.readyState !== WebSocket.OPEN || isConnecting) return;
    
    // Re-check URL validity before reporting status
    const currentUrl = window.location.href;
    if (!isAppUrl(currentUrl)) {
        // If we are not in the app frame anymore, don't report connected.
        return;
    }

    if (document.visibilityState === 'hidden') {
        ws.send(JSON.stringify({ type: 'status', status: 'background' }));
    } else {
        ws.send(JSON.stringify({ type: 'status', status: 'connected', url: currentUrl }));
    }
});

window.addEventListener('pagehide', () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'status', status: 'closing' }));
    }
});

function executeCustomScript(ip, tunnelUrl) {
    const scriptContent = `
        window.WXCLAW_IP = "${ip}";
        window.WXCLAW_TUNNEL_URL = "${tunnelUrl}";
        console.log("WxClaw Updated: IP=${ip}, Tunnel=${tunnelUrl}");
        if (window.onWxClawUpdate) {
            window.onWxClawUpdate("${ip}", "${tunnelUrl}");
        }
    `;

    const script = document.createElement('script');
    script.textContent = scriptContent;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
}
let lastUrl = '';
// Use history API patch and popstate for SPA URL changes
const handleUrlChange = () => {
    const url = window.location.href;
    console.warn('handleUrlChange', url, lastUrl);
    if (url === lastUrl) return;
    lastUrl = url;
    
    // Check if we are in the app page
    if (isAppUrl(url)) {
        // In app scope
        if (!ws || ws.readyState !== WebSocket.OPEN) {
             console.log('URL changed to app scope, connecting...');
             connect();
        } else {
             // If already connected, update status
             ws.send(JSON.stringify({ type: 'status', status: 'connected', url: url }));
        }
    } else {
        // Out of app scope
        console.log('URL changed out of app scope, closing connection.');
        if (ws) {
            // Send closing status if possible
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'status', status: 'closing' }));
            }
            ws.close();
        }
    }
};

window.addEventListener('popstate', handleUrlChange);
// MutationObserver is heavy, but effective for pushState if not patched.
// Let's keep MutationObserver but optimize check.
new MutationObserver(() => {
    if (window.location.href !== lastUrl) handleUrlChange();
}).observe(document, { subtree: true, childList: true });

// --- Configuration Helpers ---
const CONFIG_SELECTORS = {
    ip: {
        openBtn: '.app_card_operate.app_card_operate_Init.js_show_ipConfig_dialog',
        textarea: '.js_ipConfig_textarea',
        confirmBtn: '.js_ipConfig_confirmBtn'
    },
    tunnel: {
        openBtn: '.js_show_edit_callback',
        editBtn: '.apiApp_callback_showCnt_linkGroup_edit.js_callback_edit_btn',
        urlInput: '.apiApp_callback_configSection_urlInput',
        saveBtn: '.js_save_callback',
        cancelBtn:'.qui_btn.js_back_btn',
        closeBtn: '.js_back_btnlback'
    }
};

async function waitForElement(selector, timeout = 5000) {
    const el = document.querySelector(selector);
    if (el) return el;
    
    return new Promise((resolve, reject) => {
        const observer = new MutationObserver(() => {
            const el = document.querySelector(selector);
            if (el) {
                observer.disconnect();
                resolve(el);
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => {
            observer.disconnect();
            reject(new Error(`Timeout waiting for ${selector}`));
        }, timeout);
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function safeClick(element) {
    if (!element) return;
    element.click();
    // Fallback for some frameworks or hidden elements
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
}

async function configureIp(newIp) {
    try {
        console.log('Starting IP configuration...');
        const openBtn = document.querySelector(CONFIG_SELECTORS.ip.openBtn);
        if (!openBtn) {
            console.warn('IP Config Open Button not found. Might be already open or wrong page.');
             // If we can find the textarea directly, maybe it's already open?
             const textarea = document.querySelector(CONFIG_SELECTORS.ip.textarea);
             if (!textarea) throw new Error('IP Config Open Button not found');
        } else {
             console.log('Clicking IP Open Button');
             safeClick(openBtn);
        }
        
        const textarea = await waitForElement(CONFIG_SELECTORS.ip.textarea);
        await sleep(500); // Wait for animation
        
        console.log('Setting IP value');
        textarea.value = newIp;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
        
        await sleep(200);
        
        const confirmBtn = await waitForElement(CONFIG_SELECTORS.ip.confirmBtn);
        console.log('Clicking IP Confirm Button');
        safeClick(confirmBtn);
        
        console.log('IP Configuration submitted.');
        
        // Report success
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'config_success', configType: 'ip', value: newIp }));
        }
    } catch (e) {
        console.error('Configure IP failed:', e);
    }
}

async function configureTunnel(fullUrl, tunnelDomain) {
    try {
        console.log('Starting Tunnel configuration...', fullUrl);
        const openBtn = document.querySelector(CONFIG_SELECTORS.tunnel.openBtn);
        
        // Check if already in edit mode?
        const input = document.querySelector(CONFIG_SELECTORS.tunnel.urlInput);
        
        if (!input) {
            // Try to find edit button directly first
            let editBtn = document.querySelector(CONFIG_SELECTORS.tunnel.editBtn);
            
            if (editBtn) {
                 console.log('Clicking Tunnel Edit Button (Direct)');
                 safeClick(editBtn);
            } else {
                 if (!openBtn) throw new Error('Tunnel Config Open/Edit Button not found');
                 console.log('Clicking Tunnel Open Button');
                 safeClick(openBtn);
                 // After clicking open, wait for edit button
                 editBtn = await waitForElement(CONFIG_SELECTORS.tunnel.editBtn);
                 console.log('Clicking Tunnel Edit Button (After Open)');
                 safeClick(editBtn);
            }
            await sleep(500);
        }
        
        const urlInput = await waitForElement(CONFIG_SELECTORS.tunnel.urlInput);
        console.log('Setting Tunnel URL value');
        urlInput.value = fullUrl;
        urlInput.dispatchEvent(new Event('input', { bubbles: true }));
        urlInput.dispatchEvent(new Event('change', { bubbles: true }));
        
        await sleep(200);
        
        const saveBtn = await waitForElement(CONFIG_SELECTORS.tunnel.saveBtn);
        console.log('Clicking Tunnel Save Button');
        safeClick(saveBtn);

        // Polling for success or error
        const maxAttempts = 20; // 10 seconds max (500ms interval)
        let attempts = 0;
        let success = false;
        let errorMessage = null;

        while (attempts < maxAttempts) {
            await sleep(500);
            attempts++;

            const errorTip = document.querySelector('#js_tips');
            console.warn('errorTip',errorTip)
            // Check for error
            // Case 1: Error tip is visible and has error class or text implies failure
            // Note: '保存成功' might be in the same tip element but with different class/style?
            // Usually success toast appears and then disappears, or button resets.
            // If errorTip is visible:
            if (errorTip) {
                const text = errorTip.innerText;
                if (text.includes('保存成功')) {
                    success = true;
                    break;
                } else if (text) {
                    errorMessage = text;
                    break;
                }
            }

            // Check if save button disappeared (success indicator in some UIs)
            // Or if edit mode exited (urlInput gone)
            const inputStillVisible = document.querySelector(CONFIG_SELECTORS.tunnel.urlInput);
            if (!inputStillVisible) {
                success = true;
                break;
            }
        }

        if (errorMessage) {
            console.warn('Configuration rejected by server:', errorMessage);
            // Click cancel to exit edit mode
            const cancelBtn = document.querySelector(CONFIG_SELECTORS.tunnel.cancelBtn);
            if (cancelBtn) {
                 console.log('Clicking Cancel Button due to error');
                 safeClick(cancelBtn);
            }
            
            // Notify daemon about the error
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ 
                    type: 'config_error', 
                    configType: 'tunnel', 
                    error: errorMessage 
                }));
            }
            
            throw new Error(`Server Rejected: ${errorMessage}`);
        } else if (!success) {
             // Timeout
             console.warn('Configuration timeout or unknown state');
             // Try to cleanup
             const cancelBtn = document.querySelector(CONFIG_SELECTORS.tunnel.closeBtn);
             if (cancelBtn) safeClick(cancelBtn);
             
             if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ 
                    type: 'config_error', 
                    configType: 'tunnel', 
                    error: 'Configuration timed out' 
                }));
            }
            throw new Error('Configuration timed out');
        }
        
        console.log('Tunnel Configuration submitted and accepted.');
        
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'config_success', configType: 'tunnel', value: fullUrl, domain: tunnelDomain }));
        }
    } catch (e) {
        console.error('Configure Tunnel failed:', e);
    }
    try {
        const closeBtn = document.querySelector(CONFIG_SELECTORS.tunnel.closeBtn);
        if (closeBtn && closeBtn.offsetParent !== null) {
            console.log('Cleaning up: Clicking close button');
            safeClick(closeBtn);
        }
    } catch(cleanupErr) {
        console.warn('Cleanup failed:', cleanupErr);
    }
}

// Start connection
connect();