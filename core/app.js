process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const express = require('express');
const wpAdapter = require('./src/adapters/wordpressAdapter');
const axios = require('axios');
const app = express();
const PORT = 3000;
const SIC = '5e12Tf5aLJ3jAlEHf2kBkgtMRy1RSWZA'

app.get('/test-wp', async (req, res) => {
    const data = await wpAdapter.getPosts();
    res.json(data);
});

// בתוך app.js
app.get('/api/test-create', async (req, res) => {
    console.log("מנסה ליצור פוסט חדש...");
    
    const result = await wpAdapter.createPost(
        "בדיקת אדפטר - " + new Date().toLocaleTimeString(),
        "אם אתה רואה את זה, האדפטר הצליח לכתוב לוורדפרס בהצלחה!"
    );

    if (result) {
        res.json({ success: true, post_id: result.id, title: result.title });
    } else {
        res.status(500).json({ success: false, message: "הבדיקה נכשלה. בדוק לוגים." });
    }
});

app.get('/test-login', (req, res) => {
    const authUrl = `https://keycloak.corinthian.local/realms/CorinthianArchive/protocol/openid-connect/auth?client_id=forum-archive&response_type=code&scope=openid+profile+email&redirect_uri=https://core.corinthian.local/callback`;
    res.redirect(authUrl);
});


app.get('/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('❌ לא התקבל קוד בשורת הכתובת.');

    console.log('🎯 הקוד יורט ם ב-Core:', code);

    try {
        // 1. בניית הפרמטרים בפורמט שקיקלוק דורש
        const params = new URLSearchParams();
        params.append('grant_type', 'authorization_code');
        params.append('client_id', 'forum-archive');
        params.append('client_secret', SIC); // ⬅️ להחליף בסוד האמיתי!
        params.append('code', code);
        params.append('redirect_uri', 'https://core.corinthian.local/callback');

        // 2. הבאת הטוקנים באמצעות fetch מובנה
        console.log('🔄 פונה ל-Token Endpoint...');
        const tokenResponse = await fetch('https://keycloak.corinthian.local/realms/CorinthianArchive/protocol/openid-connect/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params
        });

        if (!tokenResponse.ok) {
            const errText = await tokenResponse.text();
            throw new Error(`Token exchange failed: ${tokenResponse.status} - ${errText}`);
        }

        const tokenData = await tokenResponse.json();
        const accessToken = tokenData.access_token;

        console.log('🔑 הושג Access Token. פונה עכשיו ל-Userinfo Endpoint...');

        console.log('🔑 פונה ל-Userinfo דרך הכתובת החיצונית...');
        const userInfoResponse = await fetch('https://keycloak.corinthian.local/realms/CorinthianArchive/protocol/openid-connect/userinfo', {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        if (!userInfoResponse.ok) {
            const errText = await userInfoResponse.text();
            throw new Error(`Userinfo request failed: ${userInfoResponse.status} - ${errText}`);
        }

        const userInfoData = await userInfoResponse.json();

        console.log('\n=== 🔍 הנתונים שחוזרים מ-USERINFO ENDPOINT ===\n', userInfoData);

        res.json({
            status: "SUCCESS",
            userinfo_endpoint_result: userInfoData
        });

    } catch (error) {
        console.error('❌ הבדיקה נכשלה בתוך ה-catch:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Core brain running on http://localhost:${PORT}`);
});