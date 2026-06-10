import express from 'express';
import fs from 'fs';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, Browsers, jidNormalizedUser, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pn from 'awesome-phonenumber';

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

// Function to convert session folder to Base64
async function getSessionBase64(sessionPath) {
    try {
        const credsFile = sessionPath + '/creds.json';
        if (!fs.existsSync(credsFile)) return null;
        
        const credsContent = fs.readFileSync(credsFile);
        const base64Session = credsContent.toString('base64');
        return base64Session;
    } catch (error) {
        console.error('Error converting session to base64:', error);
        return null;
    }
}

router.get('/', async (req, res) => {
    let num = req.query.number;
    let dirs = './' + (num || `session`);

    // Remove existing session if present
    await removeFile(dirs);

    // Clean the phone number - remove any non-digit characters
    num = num.replace(/[^0-9]/g, '');

    // Validate the phone number using awesome-phonenumber
    const phone = pn('+' + num);
    if (!phone.isValid()) {
        if (!res.headersSent) {
            return res.status(400).send({ 
                success: false,
                message: 'Invalid phone number. Please enter your full international number (e.g., 15551234567 for US, 447911123456 for UK) without + or spaces.' 
            });
        }
        return;
    }
    // Use the international number format (E.164, without '+')
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
                    console.log("📱 Generating Base64 session for user...");
                    
                    try {
                        // Get Base64 session
                        const base64Session = await getSessionBase64(dirs);
                        
                        if (base64Session) {
                            // Send Base64 session to user
                            const userJid = jidNormalizedUser(num + '@s.whatsapp.net');
                            
                            // Send Base64 session as text message
                            await SILA_MD.sendMessage(userJid, {
                                text: `*🎉 SILA-MD Session Generated Successfully!* 🎉\n\n` +
                                      `*📱 Your Session (Base64):*\n` +
                                      `\`\`\`${base64Session}\`\`\`\n\n` +
                                      `*⚠️ IMPORTANT:*\n` +
                                      `• Save this session securely\n` +
                                      `• Do not share with anyone\n` +
                                      `• Use it to restore your bot anytime\n\n` +
                                      `*🔧 How to use:*\n` +
                                      `1. Copy the base64 string above\n` +
                                      `2. Save it as creds_base64.txt\n` +
                                      `3. To restore: Decode base64 to creds.json\n\n` +
                                      `*🤖 Bot:* SILA-MD\n` +
                                      `*👨‍💻 Owner:* SILA\n` +
                                      `*⭐ Version:* 2.0.0`
                            });
                            console.log("📄 Base64 session sent successfully");
                            
                            // Also send as document for easy saving
                            const sessionBuffer = Buffer.from(base64Session);
                            await SILA_MD.sendMessage(userJid, {
                                document: sessionBuffer,
                                mimetype: 'text/plain',
                                fileName: 'SILA-MD_Session.txt'
                            });
                            console.log("📎 Session file sent as document");

                            // Send video thumbnail with caption
                            await SILA_MD.sendMessage(userJid, {
                                image: { url: 'https://img.youtube.com/vi/-oz_u1iMgf8/maxresdefault.jpg' },
                                caption: `🎬 *SILA-MD V2.0 Full Setup Guide!*\n\n🚀 Bug Fixes + New Commands + Fast AI Chat\n📺 Watch Now: https://youtu.be/NjOipI2AoMk`
                            });
                            console.log("🎬 Video guide sent successfully");

                            // Send warning message
                            await SILA_MD.sendMessage(userJid, {
                                text: `⚠️ *DO NOT SHARE THIS SESSION WITH ANYBODY* ⚠️\n\n` +
                                      `┌┤✑  Thanks for using SILA-MD\n` +
                                      `│└────────────┈ ⳹        \n` +
                                      `│©2025 SILA \n` +
                                      `└─────────────────┈ ⳹\n\n` +
                                      `*💾 Save this session message!*`
                            });
                            console.log("⚠️ Warning message sent successfully");

                            // Clean up session after use
                            console.log("🧹 Cleaning up session...");
                            await delay(1000);
                            removeFile(dirs);
                            console.log("✅ Session cleaned up successfully");
                            console.log("🎉 Process completed successfully!");
                            
                            // Send success response to the HTTP request
                            if (!res.headersSent) {
                                res.send({ 
                                    success: true, 
                                    message: 'Session generated and sent to your WhatsApp!',
                                    type: 'base64'
                                });
                            }
                        } else {
                            throw new Error('Failed to generate Base64 session');
                        }
                    } catch (error) {
                        console.error("❌ Error sending messages:", error);
                        removeFile(dirs);
                        if (!res.headersSent) {
                            res.status(500).send({ 
                                success: false, 
                                message: 'Error generating session: ' + error.message 
                            });
                        }
                    }
                }

                if (isNewLogin) {
                    console.log("🔐 New login via pair code");
                }

                if (isOnline) {
                    console.log("📶 Client is online");
                }

                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;

                    if (statusCode === 401) {
                        console.log("❌ Logged out from WhatsApp. Need to generate new pair code.");
                    } else {
                        console.log("🔁 Connection closed — restarting...");
                        initiateSession();
                    }
                }
            });

            if (!SILA_MD.authState.creds.registered) {
                await delay(3000); // Wait 3 seconds before requesting pairing code
                num = num.replace(/[^\d+]/g, '');
                if (num.startsWith('+')) num = num.substring(1);

                try {
                    let code = await SILA_MD.requestPairingCode(num);
                    code = code?.match(/.{1,4}/g)?.join('-') || code;
                    if (!res.headersSent) {
                        console.log({ num, code });
                        await res.send({ 
                            success: true, 
                            code: code,
                            message: 'Pairing code sent! Enter it in WhatsApp.'
                        });
                    }
                } catch (error) {
                    console.error('Error requesting pairing code:', error);
                    if (!res.headersSent) {
                        res.status(503).send({ 
                            success: false, 
                            message: 'Failed to get pairing code. Please check your phone number and try again.' 
                        });
                    }
                }
            }

            SILA_MD.ev.on('creds.update', saveCreds);
        } catch (err) {
            console.error('Error initializing session:', err);
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
