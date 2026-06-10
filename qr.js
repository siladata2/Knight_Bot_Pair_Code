import express from 'express';
import fs from 'fs';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, Browsers, jidNormalizedUser, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { delay } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { sendButtons } from 'gifted-btns';

const router = express.Router();

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

async function getSessionBase64(sessionPath) {
    try {
        const credsFile = sessionPath + '/creds.json';
        if (!fs.existsSync(credsFile)) return null;
        
        const credsContent = fs.readFileSync(credsFile);
        const base64Session = credsContent.toString('base64');
        const prefixedBase64 = `SILA-MD~${base64Session}`;
        return prefixedBase64;
    } catch (error) {
        console.error('Error:', error);
        return null;
    }
}

router.get('/', async (req, res) => {
    const sessionId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
    const dirs = `./qr_sessions/session_${sessionId}`;

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

            const handleQRCode = async (qr) => {
                if (qrGenerated || responseSent) return;
                
                qrGenerated = true;
                console.log('🟢 QR Code Generated!');
                
                try {
                    const qrDataURL = await QRCode.toDataURL(qr, {
                        errorCorrectionLevel: 'M',
                        type: 'image/png',
                        quality: 0.92,
                        margin: 1
                    });

                    if (!responseSent) {
                        responseSent = true;
                        await res.send({ 
                            success: true,
                            qr: qrDataURL, 
                            message: 'Scan QR code with WhatsApp'
                        });
                    }
                } catch (qrError) {
                    console.error('Error:', qrError);
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

                if (qr && !qrGenerated) {
                    await handleQRCode(qr);
                }

                if (connection === 'open') {
                    console.log('✅ Connected!');
                    reconnectAttempts = 0;
                    
                    try {
                        const prefixedBase64 = await getSessionBase64(dirs);
                        
                        if (prefixedBase64) {
                            const userJid = Object.keys(sock.authState.creds.me || {}).length > 0 
                                ? jidNormalizedUser(sock.authState.creds.me.id) 
                                : null;
                                
                            if (userJid) {
                                const fullSession = prefixedBase64;
                                
                                // Message text
                                const msgText = `*SESSION ID ✅*\n\n${fullSession}`;
                                
                                // Buttons configuration
                                const msgButtons = [
                                    { 
                                        name: 'cta_copy', 
                                        buttonParamsJson: JSON.stringify({ 
                                            display_text: '📋 Copy Session', 
                                            copy_code: fullSession 
                                        }) 
                                    }
                                ];
                                
                                // Send buttons using gifted-btns
                                await sendButtons(sock, userJid, msgText, msgButtons);
                                console.log("📄 Session with copy button sent");
                            }
                        }
                    } catch (error) {
                        console.error("Error:", error);
                    }
                    
                    setTimeout(() => {
                        removeFile(dirs);
                    }, 15000);
                }

                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    
                    if (statusCode === 401) {
                        removeFile(dirs);
                    } else if (statusCode === 515 || statusCode === 503) {
                        reconnectAttempts++;
                        if (reconnectAttempts <= maxReconnectAttempts) {
                            setTimeout(() => {
                                try {
                                    sock = makeWASocket(socketConfig);
                                    sock.ev.on('connection.update', handleConnectionUpdate);
                                    sock.ev.on('creds.update', saveCreds);
                                } catch (err) {
                                    console.error('Reconnect failed:', err);
                                }
                            }, 2000);
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
                        message: 'Timeout' 
                    });
                    removeFile(dirs);
                }
            }, 30000);

        } catch (err) {
            console.error('Error:', err);
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

process.on('uncaughtException', (err) => {
    let e = String(err);
    if (e.includes("conflict")) return;
    if (e.includes("not-authorized")) return;
    if (e.includes("Socket connection timeout")) return;
    if (e.includes("Connection Closed")) return;
    if (e.includes("Timed Out")) return;
    console.log('Caught exception: ', err);
});

export default router;
