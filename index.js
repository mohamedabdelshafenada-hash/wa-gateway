import express from "express";
import qrcode from "qrcode";
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 10000);

// هنستدعي HuggingFace endpoint بتاعك من Render
const HF_WEBHOOK_URL = process.env.HF_WEBHOOK_URL; // مثال: https://YOUR-HF-SPACE.../api/message
const GATEWAY_KEY = process.env.GATEWAY_KEY;       // سر مشترك بين Render و HF

let latestQrDataUrl = null;
let statusText = "starting...";

app.get("/", (req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`
  <html><body style="font-family:Arial;padding:24px">
    <h2>QR Code لربط WhatsApp</h2>
    <p>WhatsApp Business → Linked devices → Link a device → امسح الـ QR</p>
    <img id="qr" style="width:320px;height:320px;border:1px solid #ddd" />
    <p id="st">Status: ...</p>
    <script>
      async function poll(){
        const r = await fetch('/qr'); const d = await r.json();
        document.getElementById('st').innerText = 'Status: ' + d.status;
        if(d.qrDataUrl) document.getElementById('qr').src = d.qrDataUrl;
        setTimeout(poll, 1200);
      }
      poll();
    </script>
  </body></html>
  `);
});

app.get("/qr", (req, res) => {
  res.json({ status: statusText, qrDataUrl: latestQrDataUrl });
});

async function callHFForReply({ from, text }) {
  if (!HF_WEBHOOK_URL) return null;

  const resp = await fetch(HF_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": GATEWAY_KEY || ""
    },
    body: JSON.stringify({ from, text })
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`HF webhook error: ${resp.status} ${t}`);
  }

  const data = await resp.json();
  return data?.reply || null;
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      statusText = "scan the QR";
      latestQrDataUrl = await qrcode.toDataURL(qr);
    }

    if (connection === "open") {
      statusText = "connected ✅";
      latestQrDataUrl = null;
    }

    if (connection === "close") {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      statusText = "disconnected: " + String(reason);

      if (reason === DisconnectReason.loggedOut) {
        statusText = "logged out. delete auth_info and restart.";
      } else {
        startBot();
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    try {
      if (type !== "notify") return;
      const msg = messages[0];
      if (!msg?.message || msg.key.fromMe) return;

      const jid = msg.key.remoteJid;
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        "";

      if (!text.trim()) return;

      statusText = "sending to HF...";

      // هنا: نبعث الرسالة لتطبيق Hugging Face بتاعك يرد
      const reply = await callHFForReply({ from: jid, text });

      statusText = "replying...";

      await sock.sendMessage(jid, { text: reply || "تمام، لحظة وهرجعلك." });

      statusText = "connected ✅";
    } catch (e) {
      console.error(e);
      statusText = "error: " + (e?.message || "unknown");
    }
  });
}

app.listen(PORT, () => console.log("Listening on", PORT));
startBot().catch((e) => console.error("Fatal:", e));
