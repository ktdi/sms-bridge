# SMS Bridge — Render Deployment

## Deploy to Render

1. Go to https://render.com and sign up (free)
2. Click **New + → Web Service**
3. Choose **Deploy an existing image** → select **Upload files** (or connect GitHub)
4. Upload this entire folder
5. Settings:
   - **Name:** sms-bridge
   - **Runtime:** Node
   - **Build Command:** (leave blank)
   - **Start Command:** `node server.js`
   - **Instance Type:** Free
6. Click **Deploy**

Render will give you a URL like: `https://sms-bridge-xxxx.onrender.com`

## After Deploying

- **Web UI:** `https://sms-bridge-xxxx.onrender.com`
- **Android URL:** `wss://sms-bridge-xxxx.onrender.com`
- **Debug page:** `https://sms-bridge-xxxx.onrender.com/debug`

Use the same Device Token in both the Android app and the web UI.

## Note
Render free tier spins down after 15 mins of inactivity.
The first connection after sleep takes ~30 seconds to wake up.
