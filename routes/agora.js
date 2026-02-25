const express = require('express');
const { RtcTokenBuilder, RtcRole } = require('agora-token');

// !!! IMPORTANT: Get these from environment variables or a secure configuration file !!!
const AGORA_APP_ID = process.env.AGORA_APP_ID || '85ed3bccf4dc4f62b3e30b834a0b5670';
const AGORA_APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE || '9c5c145a12044fabb7ae5953d4c455e6';
const EXPIRATION_TIME_SECONDS = 3600;  
const tokenExpirationInSecond = 3600
const privilegeExpirationInSecond = 3600
const tokenRouter = express.Router();

/**
 * @route GET /api/agora/token
 * @description Generates an Agora RTC Token for a client to join a channel.
 * @query {string} channel - The Channel/Room ID (e.g., 'room78')
 * @query {string} uid - The User ID (e.g., 'user8')
 * @returns {json} { token: '...', appId: '...' }
 */
tokenRouter.get('/token', (req, res) => {
    // 1. Extract required parameters from query string
    const channelName = req.query.channel;
    const userId =parseInt(req.query.uid); 
    
    // Default role is PUBLISHER (can send audio/video)
    const role = RtcRole.PUBLISHER; 

    // Input validation
    if (!channelName || !userId) {
        return res.status(400).json({ error: 'Both "channel" and "uid" parameters are required.' });
    }
    if (!AGORA_APP_ID || !AGORA_APP_CERTIFICATE) {
        return res.status(500).json({ error: 'Server misconfiguration: Agora credentials missing.' });
    }

    try {
        const currentTimestamp = Math.floor(Date.now() / 1000);
        const privilegeExpiredTs = currentTimestamp + EXPIRATION_TIME_SECONDS;

        // 2. Generate the RTC Token
        const token = RtcTokenBuilder.buildTokenWithUid(
            AGORA_APP_ID,
            AGORA_APP_CERTIFICATE,
            channelName.toString(),
            userId,
            role,
            tokenExpirationInSecond,
            privilegeExpiredTs
        );
        

        // 3. Send the token and App ID back to the client
        res.json({
            token: token,
            appId: AGORA_APP_ID,
            channelName: channelName,
            uid: userId
        });

        console.log(`✅ HTTP Token generated for Channel: ${channelName}, User: ${userId}`);
    } catch (error) {
        console.error('❌ Agora Token generation failed:', error);
        res.status(500).json({ error: 'Token generation failed', details: error.message });
    }
});

module.exports = tokenRouter;