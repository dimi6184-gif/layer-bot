import type { Message } from 'discord.js';
import { AttachmentBuilder } from 'discord.js';
import axios from 'axios';

interface ScamReportData {
  userId: string;
  username: string;
  userTag: string;
  channelId: string;
  channelName: string;
  guildName: string;
  content: string;
  confidence: number;
  reason: string;
  type: string;
  timestamp: string;
  attachments: { name: string; url: string; contentType: string; base64?: string; }[];
}

export async function generateScamReport(
  message: Message,
  scamResult: { confidence: number; reason: string; type: string }
): Promise<AttachmentBuilder> {
  const attachmentData: ScamReportData['attachments'] = [];
  
  for (const [, attachment] of message.attachments) {
    if (attachment.contentType?.startsWith('image/')) {
      // The content type comes from the uploader, so only a plain image/<subtype> value
      // may enter the data URI.
      const contentType = /^image\/[a-z0-9.+-]+$/i.test(attachment.contentType) ? attachment.contentType : 'application/octet-stream';
      try {
        if (attachment.size > 8 * 1024 * 1024 || new URL(attachment.url).hostname !== 'cdn.discordapp.com') throw new Error('skip');
        const response = await axios.get(attachment.url, {
          responseType: 'arraybuffer',
          timeout: 5000,
          maxContentLength: 8 * 1024 * 1024,
          maxRedirects: 0,
        });
        const base64 = Buffer.from(response.data).toString('base64');
        attachmentData.push({
          name: attachment.name,
          url: attachment.url,
          contentType,
          base64: `data:${contentType};base64,${base64}`
        });
      } catch (error) {
        attachmentData.push({ name: attachment.name, url: attachment.url, contentType });
      }
    }
  }

  const reportData: ScamReportData = {
    userId: message.author.id,
    username: message.author.username,
    userTag: message.author.tag,
    channelId: message.channel.id,
    channelName: message.channel.isDMBased() ? 'DM' : (message.channel as any).name,
    guildName: message.guild?.name || 'Direct Message',
    content: message.content || '[No text content]',
    confidence: scamResult.confidence,
    reason: scamResult.reason,
    type: scamResult.type,
    timestamp: new Date().toISOString(),
    attachments: attachmentData
  };

  const html = generateLayerHTML(reportData);
  const buffer = Buffer.from(html, 'utf-8');
  return new AttachmentBuilder(buffer, { name: `layer-scam-report-${message.author.id}-${Date.now()}.html` });
}

function generateLayerHTML(d: ScamReportData): string {
  // Escapes for both text and attribute context; every value here comes from the reported message.
  const esc = (t: string) => String(t ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  
  const attachmentsHTML = d.attachments.length > 0
    ? `<div class="section">
        <h2 class="section-title"><span>📎</span> Attachments (${d.attachments.length})</h2>
        ${d.attachments.map(a => `
          <div class="attachment-item">
            ${a.base64 ? `<img src="${a.base64}" alt="${esc(a.name)}" />` : ''}
            <div class="attachment-info">
              <div class="attachment-name">${esc(a.name)}</div>
              <div class="attachment-type">${esc(a.contentType)}</div>
            </div>
          </div>
        `).join('')}
      </div>`
    : '';
  
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">
  <title>Layer - Scam Report</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Inter, sans-serif; background: #0a0a0f; color: #fff; padding: 20px; }
    .container { max-width: 900px; margin: 0 auto; background: rgba(255,255,255,0.02); border-radius: 24px; border: 1px solid rgba(255,255,255,0.05); overflow: hidden; }
    .header { background: linear-gradient(135deg, #dc2626, #991b1b); padding: 40px; text-align: center; }
    .logo { font-size: 24px; font-weight: 800; margin-bottom: 10px; }
    .content { padding: 32px; }
    .section { margin-bottom: 32px; padding-bottom: 32px; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .section-title { font-size: 20px; font-weight: 700; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
    .info-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 16px; }
    .info-item { background: rgba(255,255,255,0.02); padding: 16px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.08); border-left: 3px solid #a855f7; }
    .info-label { font-size: 11px; text-transform: uppercase; color: #a1a1aa; font-weight: 600; margin-bottom: 6px; }
    .info-value { font-size: 15px; color: #fff; }
    .confidence-bar { background: rgba(255,255,255,0.05); height: 32px; border-radius: 8px; overflow: hidden; margin-top: 10px; }
    .confidence-fill { height: 100%; background: linear-gradient(90deg, #dc2626, #ef4444); display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 14px; }
    .reason-box { background: rgba(239,68,68,0.05); border: 2px solid rgba(239,68,68,0.2); border-radius: 12px; padding: 20px; margin-top: 12px; }
    .reason-box p { color: #fca5a5; line-height: 1.6; }
    .message-box { background: rgba(255,255,255,0.02); border-radius: 12px; padding: 20px; margin-top: 12px; border: 1px solid rgba(255,255,255,0.08); }
    .message-box pre { white-space: pre-wrap; word-wrap: break-word; font-size: 13px; line-height: 1.6; color: #e4e4e7; font-family: monospace; }
    .attachment-item { border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; overflow: hidden; background: rgba(255,255,255,0.02); margin-top: 16px; }
    .attachment-item img { width: 100%; height: auto; display: block; }
    .attachment-info { padding: 12px 16px; background: rgba(0,0,0,0.2); }
    .attachment-name { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
    .attachment-type { font-size: 12px; color: #a1a1aa; }
    .footer { background: rgba(255,255,255,0.02); padding: 24px; text-align: center; border-top: 1px solid rgba(255,255,255,0.05); }
    .footer-brand { font-weight: 700; color: #fff; margin-bottom: 8px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">🛡️ Layer</div>
      <h1 style="font-size: 32px; margin-bottom: 8px;">Scam Detection Report</h1>
      <p>Automated Security Analysis</p>
    </div>
    <div class="content">
      <div class="section">
        <h2 class="section-title"><span>🎯</span> Detection Results</h2>
        <div class="info-grid">
          <div class="info-item">
            <div class="info-label">Type</div>
            <div class="info-value">${esc(d.type.toUpperCase())}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Confidence</div>
            <div class="info-value">${d.confidence}%</div>
            <div class="confidence-bar">
              <div class="confidence-fill" style="width: ${d.confidence}%;">${d.confidence}%</div>
            </div>
          </div>
        </div>
        <div class="reason-box">
          <strong style="display: block; margin-bottom: 8px;">🔍 Detection Reason:</strong>
          <p>${esc(d.reason)}</p>
        </div>
      </div>
      <div class="section">
        <h2 class="section-title"><span>👤</span> User Information</h2>
        <div class="info-grid">
          <div class="info-item">
            <div class="info-label">Username</div>
            <div class="info-value">${esc(d.username)}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Tag</div>
            <div class="info-value">${esc(d.userTag)}</div>
          </div>
          <div class="info-item">
            <div class="info-label">ID</div>
            <div class="info-value">${esc(d.userId)}</div>
          </div>
        </div>
      </div>
      <div class="section">
        <h2 class="section-title"><span>🏠</span> Server & Channel</h2>
        <div class="info-grid">
          <div class="info-item">
            <div class="info-label">Server</div>
            <div class="info-value">${esc(d.guildName)}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Channel</div>
            <div class="info-value">#${esc(d.channelName)}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Time</div>
            <div class="info-value">${new Date(d.timestamp).toLocaleString()}</div>
          </div>
        </div>
      </div>
      <div class="section">
        <h2 class="section-title"><span>💬</span> Message Content</h2>
        <div class="message-box">
          <pre>${esc(d.content)}</pre>
        </div>
      </div>
      ${attachmentsHTML}
    </div>
    <div class="footer">
      <div class="footer-brand">🛡️ Powered by Layer</div>
      <p>Report ID: ${d.userId}-${Date.now()}</p>
      <p style="font-size: 12px; color: #71717a; margin-top: 8px;">${new Date(d.timestamp).toISOString()}</p>
    </div>
  </div>
</body>
</html>`;
}
