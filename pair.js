import express from 'express';
import fs from 'fs';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, Browsers, jidNormalizedUser, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pn from 'awesome-phonenumber';
import { sendButtons } from 'gifted-btns';

const router = express.Router();

// Ensure the session directory exists
function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
    } catch (e) {
        console.error('Error removing file:', e);
    }
}

// Function to convert session folder to Base64 with prefix
async function getSessionBase64(sessionPath) {
    try {
        const credsFile = sessionPath + '/creds.json';
        if (!fs.existsSync(credsFile)) return null;
        
        const credsContent = fs.readFileSync(credsFile);
        const base64Session = credsContent.toString('base64');
        const prefixedBase64 = `SILA-MD~${base64Session}`;
        return prefixedBase64;
    } catch (error) {
        console.error('Error converting session to base64:', error);
        return null;
    }
}

router.get('/', async (req, res) => {
    let num = req.query.number;
    let dirs = './' + (num || `session`);

    await removeFile(dirs);
    num = num.replace(/[^0-9]/g, '');

    const phone = pn('+' + num);
    if (!phone.isValid()) {
        if (!res.headersSent) {
            return res.status(400).send({ 
                success: false,
                message: 'Invalid phone number.' 
            });
        }
        return;
    }
    num = phone.getNumber('e164').replace('+', '');

    async function initiateSession() {
        const { state, saveCreds } = await useMultiFileAuthState(dirs);

        try {
            const { version, isLatest } = await fetchLatestBaileysVersion();
            let SILA_MD = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
                },
                printQRInTerminal: false,
                logger: pino({ level: "fatal" }).child({ level: "fatal" }),
                browser: Browsers.windows('Chrome'),
                markOnlineOnConnect: false,
                generateHighQualityLinkPreview: false,
                defaultQueryTimeoutMs: 60000,
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 30000,
                retryRequestDelayMs: 250,
                maxRetries: 5,
            });

            SILA_MD.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, isNewLogin, isOnline } = update;

                if (connection === 'open') {
                    console.log("✅ Connected successfully!");
                    
                    try {
                        const prefixedBase64 = await getSessionBase64(dirs);
                        
                        if (prefixedBase64) {
                            const userJid = jidNormalizedUser(num + '@s.whatsapp.net');
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
                            await sendButtons(SILA_MD, userJid, msgText, msgButtons);
                            console.log("📄 Session with copy button sent successfully");
                            
                            removeFile(dirs);
                            
                            if (!res.headersSent) {
                                res.send({ 
                                    success: true, 
                                    message: 'Session sent to your WhatsApp!' 
                                });
                            }
                        } else {
                            throw new Error('Failed to generate session');
                        }
                    } catch (error) {
                        console.error("❌ Error:", error);
                        removeFile(dirs);
                        if (!res.headersSent) {
                            res.status(500).send({ 
                                success: false, 
                                message: 'Error generating session' 
                            });
                        }
                    }
                }

                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    if (statusCode === 401) {
                        console.log("❌ Logged out");
                    } else {
                        initiateSession();
                    }
                }
            });

            if (!SILA_MD.authState.creds.registered) {
                await delay(3000);
                num = num.replace(/[^\d+]/g, '');
                if (num.startsWith('+')) num = num.substring(1);

                try {
                    let code = await SILA_MD.requestPairingCode(num);
                    code = code?.match(/.{1,4}/g)?.join('-') || code;
                    if (!res.headersSent) {
                        await res.send({ 
                            success: true, 
                            code: code
                        });
                    }
                } catch (error) {
                    console.error('Error:', error);
                    if (!res.headersSent) {
                        res.status(503).send({ 
                            success: false, 
                            message: 'Failed to get pairing code' 
                        });
                    }
                }
            }

            SILA_MD.ev.on('creds.update', saveCreds);
        } catch (err) {
            console.error('Error:', err);
            if (!res.headersSent) {
                res.status(503).send({ 
                    success: false, 
                    message: 'Service Unavailable' 
                });
            }
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
