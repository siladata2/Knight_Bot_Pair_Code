import express from 'express';
import fs from 'fs';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, Browsers, jidNormalizedUser, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { delay } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';

const router = express.Router();

// Function to remove files or directories
function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
        return true;
    } catch (e) {
        console.error('Error removing file:', e);
        return false;
    }
}

// Function to convert session folder to Base64 with prefix
async function getSessionBase64(sessionPath) {
    try {
        const credsFile = sessionPath + '/creds.json';
        if (!fs.existsSync(credsFile)) return null;
        
        const credsContent = fs.readFileSync(credsFile);
        const base64Session = credsContent.toString('base64');
        // Add prefix "SILA-MD~" before the base64
        const prefixedBase64 = `SILA-MD~${base64Session}`;
        return prefixedBase64;
    } catch (error) {
        console.error('Error converting session to base64:', error);
        return null;
    }
}

router.get('/', async (req, res) => {
    // Generate unique session for each request to avoid conflicts
    const sessionId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
    const dirs = `./qr_sessions/session_${sessionId}`;

    // Ensure qr_sessions directory exists
    if (!fs.existsSync('./qr_sessions')) {
        fs.mkdirSync('./qr_sessions', { recursive: true });
    }

    async function initiateSession() {
        if (!fs.existsSync(dirs)) fs.mkdirSync(dirs, { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(dirs);

        try {
            const { version, isLatest } = await fetchLatestBaileysVersion();
            
            let qrGenerated = false;
            let responseSent = false;

            // QR Code handling logic
            const handleQRCode = async (qr) => {
                if (qrGenerated || responseSent) return;
                
                qrGenerated = true;
                console.log('🟢 QR Code Generated! Scan it with your WhatsApp app.');
                console.log('📋 Instructions:');
                console.log('1. Open WhatsApp on your phone');
                console.log('2. Go to Settings > Linked Devices');
                console.log('3. Tap "Link a Device"');
                console.log('4. Scan the QR code below');
                
                try {
                    const qrDataURL = await QRCode.toDataURL(qr, {
                        errorCorrectionLevel: 'M',
                        type: 'image/png',
                        quality: 0.92,
                        margin: 1,
                        color: {
                            dark: '#000000',
                            light: '#FFFFFF'
                        }
                    });

                    if (!responseSent) {
                        responseSent = true;
                        console.log('QR Code generated successfully');
                        await res.send({ 
                            success: true,
                            qr: qrDataURL, 
                            message: 'QR Code Generated! Scan it with your WhatsApp app.',
                            instructions: [
                                '1. Open WhatsApp on your phone',
                                '2. Go to Settings > Linked Devices',
                                '3. Tap "Link a Device"',
                                '4. Scan the QR code above'
                            ]
                        });
                    }
                } catch (qrError) {
                    console.error('Error generating QR code:', qrError);
                    if (!responseSent) {
                        responseSent = true;
                        res.status(500).send({ 
                            success: false, 
                            message: 'Failed to generate QR code' 
                        });
                    }
                }
            };

            const socketConfig = {
                version,
                logger: pino({ level: 'silent' }),
                browser: Browsers.windows('Chrome'),
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
                },
                markOnlineOnConnect: false,
                generateHighQualityLinkPreview: false,
                defaultQueryTimeoutMs: 60000,
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 30000,
                retryRequestDelayMs: 250,
                maxRetries: 5,
            };

            let sock = makeWASocket(socketConfig);
            let reconnectAttempts = 0;
            const maxReconnectAttempts = 3;

            const handleConnectionUpdate = async (update) => {
                const { connection, lastDisconnect, qr } = update;
                console.log(`🔄 Connection update: ${connection || 'undefined'}`);

                if (qr && !qrGenerated) {
                    await handleQRCode(qr);
                }

                if (connection === 'open') {
                    console.log('✅ Connected successfully!');
                    console.log('💾 Session saved to:', dirs);
                    reconnectAttempts = 0;
                    
                    try {
                        const prefixedBase64 = await getSessionBase64(dirs);
                        
                        if (prefixedBase64) {
                            const userJid = Object.keys(sock.authState.creds.me || {}).length > 0 
                                ? jidNormalizedUser(sock.authState.creds.me.id) 
                                : null;
                                
                            if (userJid) {
                                await sock.sendMessage(userJid, {
                                    text: `*🎉 SILA-MD Session Generated Successfully!* 🎉\n\n` +
                                          `*📱 Your Session:*\n` +
                                          `\`\`\`${prefixedBase64}\`\`\`\n\n` +
                                          `*⚠️ IMPORTANT:*\n` +
                                          `• Save this session securely\n` +
                                          `• Do not share with anyone\n` +
                                          `• Use it to restore your bot anytime\n\n` +
                                          `*🔧 How to use:*\n` +
                                          `1. Copy the full session string above\n` +
                                          `2. It starts with "SILA-MD~" followed by base64\n` +
                                          `3. Save it as your session\n\n` +
                                          `*🤖 Bot:* SILA-MD\n` +
                                          `*👨‍💻 Owner:* SILA\n` +
                                          `*⭐ Version:* 2.0.0`
                                });
                                console.log("📄 Base64 session sent successfully to", userJid);
                                
                                const sessionBuffer = Buffer.from(prefixedBase64);
                                await sock.sendMessage(userJid, {
                                    document: sessionBuffer,
                                    mimetype: 'text/plain',
                                    fileName: 'SILA-MD_Session.txt'
                                });
                                console.log("📎 Session file sent as document");
                                
                                await sock.sendMessage(userJid, {
                                    text: `⚠️ *DO NOT SHARE THIS SESSION WITH ANYBODY* ⚠️\n\n` +
                                          `┌┤✑  Thanks for using SILA-MD\n` +
                                          `│└────────────┈ ⳹        \n` +
                                          `│©2025 SILA \n` +
                                          `└─────────────────┈ ⳹\n\n` +
                                          `*💾 Save this session message!*\n` +
                                          `*📝 Session Format:* SILA-MD~[base64]`
                                });
                                console.log("⚠️ Warning message sent successfully");
                            } else {
                                console.log("❌ Could not determine user JID to send session");
                            }
                        } else {
                            console.log("❌ Failed to generate Base64 session");
                        }
                    } catch (error) {
                        console.error("Error sending session:", error);
                    }
                    
                    setTimeout(() => {
                        console.log('🧹 Cleaning up session...');
                        const deleted = removeFile(dirs);
                        if (deleted) {
                            console.log('✅ Session cleaned up successfully');
                        } else {
                            console.log('❌ Failed to clean up session folder');
                        }
                    }, 15000);
                }

                if (connection === 'close') {
                    console.log('❌ Connection closed');
                    if (lastDisconnect?.error) {
                        console.log('❗ Last Disconnect Error:', lastDisconnect.error);
                    }
                    
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    
                    if (statusCode === 401) {
                        console.log('🔐 Logged out - need new QR code');
                        removeFile(dirs);
                    } else if (statusCode === 515 || statusCode === 503) {
                        console.log(`🔄 Stream error (${statusCode}) - attempting to reconnect...`);
                        reconnectAttempts++;
                        
                        if (reconnectAttempts <= maxReconnectAttempts) {
                            console.log(`🔄 Reconnect attempt ${reconnectAttempts}/${maxReconnectAttempts}`);
                            setTimeout(() => {
                                try {
                                    sock = makeWASocket(socketConfig);
                                    sock.ev.on('connection.update', handleConnectionUpdate);
                                    sock.ev.on('creds.update', saveCreds);
                                } catch (err) {
                                    console.error('Failed to reconnect:', err);
                                }
                            }, 2000);
                        } else {
                            console.log('❌ Max reconnect attempts reached');
                            if (!responseSent) {
                                responseSent = true;
                                res.status(503).send({ 
                                    success: false, 
                                    message: 'Connection failed after multiple attempts' 
                                });
                            }
                        }
                    }
                }
            };

            sock.ev.on('connection.update', handleConnectionUpdate);
            sock.ev.on('creds.update', saveCreds);

            setTimeout(() => {
                if (!responseSent) {
                    responseSent = true;
                    res.status(408).send({ 
                        success: false, 
                        message: 'QR generation timeout' 
                    });
                    removeFile(dirs);
                }
            }, 30000);

        } catch (err) {
            console.error('Error initializing session:', err);
            if (!res.headersSent) {
                res.status(503).send({ 
                    success: false, 
                    message: 'Service Unavailable' 
                });
            }
            removeFile(dirs);
        }
    }

    await initiateSession();
});

// Global uncaught exception handler
process.on('uncaughtException', (err) => {
    let e = String(err);
    if (e.includes("conflict")) return;
    if (e.includes("not-authorized")) return;
    if (e.includes("Socket connection timeout")) return;
    if (e.includes("rate-overlimit")) return;
    if (e.includes("Connection Closed")) return;
    if (e.includes("Timed Out")) return;
    if (e.includes("Value not found")) return;
    if (e.includes("Stream Errored")) return;
    if (e.includes("Stream Errored (restart required)")) return;
    if (e.includes("statusCode: 515")) return;
    if (e.includes("statusCode: 503")) return;
    console.log('Caught exception: ', err);
});

export default router;
