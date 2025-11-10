// index.js
// WhatsApp bot (Baileys) — single file
// Fitur: terminal commands + kontrol via private chat (owner)
// Support: hidden mention (single), tag all hidden, kirim file, kirim file+tagall, reply, list groups, logs
// Owner (admin) yang boleh kirim command via private chat:
const OWNER_JID = '62895357861871@s.whatsapp.net'

import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} from '@whiskeysockets/baileys'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import fs from 'fs'
import path from 'path'
import chalk from 'chalk'

// -----------------------------
// Utility functions & constants
// -----------------------------
function safeLog(...args) { console.log(...args) }

function loadOrCreateLogsFile() {
  try {
    if (!fs.existsSync('logs.txt')) fs.writeFileSync('logs.txt', '')
  } catch (e) { /* ignore */ }
}

// Extract readable text from various message types
function extractTextFromMessage(message) {
  if (!message) return ''
  if (message.conversation) return message.conversation
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text
  if (message.imageMessage?.caption) return `[Gambar] ${message.imageMessage.caption}`
  if (message.videoMessage?.caption) return `[Video] ${message.videoMessage.caption}`
  if (message.stickerMessage) return '[Stiker]'
  if (message.documentMessage) return `[Dokumen] ${message.documentMessage.fileName || ''}`
  if (message.audioMessage) return '[Audio]'
  if (message.contactMessage) return '[Kontak]'
  if (message.locationMessage) return '[Lokasi]'
  if (message.buttonsResponseMessage) return `[Tombol] ${message.buttonsResponseMessage.selectedButtonId}`
  if (message.listResponseMessage) return `[List] ${message.listResponseMessage.title}`
  if (message.reactionMessage) return `[Reaksi] ${message.reactionMessage.text}`
  return ''
}

// Determine mime type by file extension (simple)
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) return 'image/' + ext.slice(1)
  if (['.mp4', '.mkv', '.mov'].includes(ext)) return 'video/' + ext.slice(1)
  if (['.mp3', '.ogg', '.wav'].includes(ext)) return 'audio/' + ext.slice(1)
  return 'application/octet-stream'
}

// === FORMAT UPTIME KE JAM-MENIT-DETIK ===
function formatUptime(seconds) {
    const h = Math.floor(seconds / 3600).toString().padStart(2, "0");
    const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
    const s = Math.floor(seconds % 60).toString().padStart(2, "0");
    return `${h}:${m}:${s}`;
}

// -----------------------------
// Start Bot
// -----------------------------
async function start() {
  loadOrCreateLogsFile()

  // auth state
  const { state, saveCreds } = await useMultiFileAuthState('./session')
  const { version } = await fetchLatestBaileysVersion()

  // create socket
  const sock = makeWASocket({
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
        // ============================
        //  🟩 OVERRIDE DEVICE NAME
        // ============================
        browser: ["Daffa's-Bot", "Chrome", "1.0"],
        // WhatsApp akan menampilkan:
        // "Daffa's-Bot — Chrome"
        // di menu Tautkan Perangkat
    auth: state,
    version
  })

  // save creds on update
  sock.ev.on('creds.update', saveCreds)

  // store last message key per chat for reply feature
  const lastMessages = {} // { chatId: msg.key }

  // -----------------------------
  // CONNECTION UPDATE handler
  // -----------------------------
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update

    // Show QR in terminal when needed
    if (qr) {
      qrcode.generate(qr, { small: true })
      safeLog('📱 Scan QR dari WhatsApp kamu (Linked devices → Link a device).')
    }

    if (connection === 'open') {
      safeLog('✅ Terhubung ke WhatsApp!\n')
      listGroups(sock)
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode
      safeLog('❌ Koneksi terputus:', reason)

      if (reason !== DisconnectReason.loggedOut) {
        safeLog('🔁 Mencoba menyambung ulang...')
        start() // auto reconnect (restart)
      } else {
        safeLog('🚪 Sesi kadaluarsa. Hapus folder "session" lalu jalankan ulang untuk scan QR baru.')
      }
    }
  })

  // -----------------------------
  // Single messages.upsert handler
  // - Handles: logging, saving lastMessages, commands from owner (private), and general display
  // -----------------------------
  sock.ev.on('messages.upsert', async (m) => {
    try {
      const msg = m.messages?.[0]
      if (!msg || msg.key.fromMe) return // ignore outgoing/from-me

      const chatId = msg.key.remoteJid // where the message was sent (group id or private)
      const sender = msg.key.participant || msg.key.remoteJid // actual sender in groups or private
      const time = new Date().toLocaleTimeString('id-ID', { hour12: false })

      // Extract readable text (or placeholder for non-text messages)
      const messageContent = extractTextFromMessage(msg.message)

      // Save last message key for reply feature
      lastMessages[chatId] = msg.key

      // Log to file
      const logText = `[${new Date().toLocaleString()}] Dari: ${sender} | Chat: ${chatId} | Pesan: ${messageContent}\n`
      fs.appendFileSync('logs.txt', logText)

      // Display in terminal (group vs private)
      if (chatId.endsWith('@g.us')) {
        // message from group
        // try to get group name (best effort)
        let groupName = chatId
        try {
          const metadata = await sock.groupMetadata(chatId)
          groupName = metadata.subject || groupName
        } catch (e) { /* ignore */ }

        safeLog(
          chalk.green(`👥 [${time}] Grup: ${groupName}\n`) +
          chalk.cyan(`Dari: ${sender}\n`) +
          chalk.white(`Pesan: ${messageContent}\n`)
        )
      } else {
        // private chat - show sender (use pushName if available)
        const displayName = msg.pushName || sender
        safeLog(
          chalk.blue(`💬 [${time}] Dari: ${displayName} (${sender})\n`) +
          chalk.white(`Pesan: ${messageContent}\n`)
        )
      }

      // -----------------------------
      // HANDLER: commands sent via PRIVATE CHAT (owner only)
      // - Owner sends commands as text starting with '!' to the bot in private chat
      // Examples:
      //   !ping
      //   !tagall 1203630xxxxx@g.us|Halo semua
      //   !tag 628xxxx|Hai
      //   !file 1203630xxxxx@g.us|C:\path\file.jpg|Caption
      //   !reply 1203630xxxxx@g.us|Hai semuanya (this replies to last message in that chat)
      // -----------------------------
      const isPrivateToBot = (chatId === OWNER_JID) // owner chatting privately to bot
      const isOwner = (sender === OWNER_JID || chatId === OWNER_JID)

      if (isPrivateToBot && typeof messageContent === 'string' && messageContent.trim().startsWith('!') && isOwner) {
        const raw = messageContent.trim().slice(1).trim() // remove '!'
        // Support separators by pipe '|' or space. Prefer pipe for multi-part args.
        const parts = raw.includes('|') ? raw.split('|').map(s => s.trim()) : raw.split(/\s+/)
        const cmd = parts[0].toLowerCase()

        // --- !ping ---
        if (cmd === 'ping') {
  try {
    // uptime
    const uptimeSeconds = process.uptime()
    const hours = Math.floor(uptimeSeconds / 3600)
    const minutes = Math.floor((uptimeSeconds % 3600) / 60)
    const seconds = Math.floor(uptimeSeconds % 60)
    const uptime = `${hours.toString().padStart(2, '0')}:${minutes
      .toString()
      .padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`

    // RAM used
    const ramUsedMB = Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10

    // CPU load
    let cpu = 'n/a'
    try {
      cpu = os.loadavg()[0].toFixed(2)
    } catch (e) {
      cpu = 'n/a'
    }

    // Latency test
    const t0 = Date.now()
    await sock.sendMessage(OWNER_JID, { text: 'Testing speed...' })
    const t1 = Date.now()
    const speed = t1 - t0

    // Final message
    const text =
`🏓 PING BOT
• Status: Online
• Uptime: ${uptime}
• RAM Used: ${ramUsedMB} MB
• CPU Load: ${cpu}
• Speed: ${speed}ms`

    await sock.sendMessage(OWNER_JID, { text })
  } catch (e) {
    await sock.sendMessage(OWNER_JID, { text: '❌ Ping error: ' + e })
  }
  return
}


        // --- !help ---
        if (cmd === 'help') {
          const helpText =
`📋 Daftar Command (via private chat ke bot)
!ping
!help
!status
!tagall <groupId>|<pesan>
!tag <nomor>|<pesan>   (nomor seperti 6281234567890 atau jid)
!file <groupId>|<C:\\path\\file.jpg>|<caption optional>
!filetag <groupId>|<C:\\path\\file.jpg>|<caption optional>
!reply <chatId>|<pesan>   (reply ke pesan terakhir chatId)
!groups
!log last  (lihat 10 baris terakhir logs)
`
          await sock.sendMessage(OWNER_JID, { text: helpText })
          return
        }

        // --- !status ---
        if (cmd === 'status') {
          let groupsCount = 0
          try {
            const g = await sock.groupFetchAllParticipating()
            groupsCount = Object.keys(g).length
          } catch (e) { /* ignore */ }

          const status = `🤖 Bot Status
Connected: yes
Groups joined: ${groupsCount}
Logs file: logs.txt
`
          await sock.sendMessage(OWNER_JID, { text: status })
          return
        }

        // --- !groups (list groups) ---
        if (cmd === 'groups') {
          try {
            const groups = await sock.groupFetchAllParticipating()
            const list = Object.values(groups).map((g, i) => `${i + 1}. ${g.subject} (${g.id})`).join('\n') || '(tidak ada grup)'
            await sock.sendMessage(OWNER_JID, { text: `📚 Grup yang bot gabung:\n${list}` })
          } catch (e) {
            await sock.sendMessage(OWNER_JID, { text: `❌ Gagal mengambil daftar grup: ${e}` })
          }
          return
        }

        // --- !tagall <groupId>|<pesan> ---
        if (cmd === 'tagall') {
          const groupId = parts[1]
          const pesan = parts.slice(2).join('|') || '(tanpa pesan)'
          if (!groupId) {
            await sock.sendMessage(OWNER_JID, { text: '❗ Format: !tagall <groupId>|<pesan>' })
            return
          }
          await tagAllHidden(groupId.trim(), pesan)
          await sock.sendMessage(OWNER_JID, { text: `✔ Tagall dikirim ke ${groupId}` })
          return
        }

        // --- !tag <nomor>|<pesan> ---
        if (cmd === 'tag') {
          const target = parts[1]
          const pesan = parts.slice(2).join('|') || '(tanpa pesan)'
          if (!target) {
            await sock.sendMessage(OWNER_JID, { text: '❗ Format: !tag <nomor>|<pesan>' })
            return
          }
          const targetJid = target.includes('@') ? target : `${target.replace(/\D/g, '')}@s.whatsapp.net`
          // default target group? use chatId? Here we expect owner to send in private; target must be a jid in a group (participant) and group must be provided in place of recipient when calling sendHiddenMention
          await sock.sendMessage(OWNER_JID, { text: '⌛ Mengirim...' })
          // If you want to tag a user inside a group, call sendHiddenMention with group id as first param and targetJid as second.
          // Here we assume owner wants to call by specifying group later; instead instruct owner to use !tagin <groupId>|<nomor>|<pesan>
          await sock.sendMessage(OWNER_JID, { text: '❗ Untuk tag di grup gunakan: !tagin <groupId>|<nomor>|<pesan>' })
          return
        }

        // --- !tagin <groupId>|<nomor>|<pesan> ---
        if (cmd === 'tagin') {
          const groupId = parts[1]
          const number = parts[2]
          const pesan = parts.slice(3).join('|') || '(tanpa pesan)'
          if (!groupId || !number) {
            await sock.sendMessage(OWNER_JID, { text: '❗ Format: !tagin <groupId>|<nomor>|<pesan>' })
            return
          }
          const targetJid = number.includes('@') ? number : `${number.replace(/\D/g, '')}@s.whatsapp.net`
          await sendHiddenMention(groupId.trim(), targetJid, pesan)
          await sock.sendMessage(OWNER_JID, { text: `✔ Mention tersembunyi dikirim ke ${number} di grup ${groupId}` })
          return
        }

        // --- !file <groupId>|<path>|<caption> ---
        if (cmd === 'file') {
          const groupId = parts[1]
          const filePath = parts[2]
          const caption = parts.slice(3).join('|') || ''
          if (!groupId || !filePath) {
            await sock.sendMessage(OWNER_JID, { text: '❗ Format: !file <groupId>|<path>|<caption>' })
            return
          }
          await sendFile(groupId.trim(), filePath.trim(), caption)
          await sock.sendMessage(OWNER_JID, { text: `✔ File dikirim ke ${groupId}` })
          return
        }

        // --- !filetag <groupId>|<path>|<caption> ---
        if (cmd === 'filetag') {
          const groupId = parts[1]
          const filePath = parts[2]
          const caption = parts.slice(3).join('|') || ''
          if (!groupId || !filePath) {
            await sock.sendMessage(OWNER_JID, { text: '❗ Format: !filetag <groupId>|<path>|<caption>' })
            return
          }
          await sendFileTagAll(groupId.trim(), filePath.trim(), caption)
          await sock.sendMessage(OWNER_JID, { text: `✔ File + tagall dikirim ke ${groupId}` })
          return
        }

        // --- !reply <chatId>|<pesan> ---
        if (cmd === 'reply') {
          const chatId = parts[1]
          const pesan = parts.slice(2).join('|') || ''
          if (!chatId || !pesan) {
            await sock.sendMessage(OWNER_JID, { text: '❗ Format: !reply <chatId>|<pesan>' })
            return
          }
          if (!lastMessages[chatId]) {
            await sock.sendMessage(OWNER_JID, { text: `⚠️ Tidak ada pesan terakhir untuk chat ${chatId}` })
            return
          }
          const isGroup = chatId.endsWith('@g.us')
          if (isGroup) {
            const metadata = await sock.groupMetadata(chatId)
            const participants = metadata.participants.map(p => p.id)
            await sock.sendMessage(chatId, {
              text: pesan,
              quoted: lastMessages[chatId],
              mentions: participants
            })
            await sock.sendMessage(OWNER_JID, { text: `✅ Reply + tagall dikirim ke grup ${metadata.subject}` })
          } else {
            await sock.sendMessage(chatId, {
              text: pesan,
              quoted: lastMessages[chatId]
            })
            await sock.sendMessage(OWNER_JID, { text: `✅ Reply dikirim ke ${chatId}` })
          }
          return
        }

        // --- !log last (show last 10 lines of logs) ---
        if (cmd === 'log' && parts[1] === 'last') {
          try {
            const content = fs.readFileSync('logs.txt', 'utf8')
            const lines = content.trim().split('\n').slice(-10).join('\n') || '(logs kosong)'
            await sock.sendMessage(OWNER_JID, { text: `📄 Last 10 logs:\n${lines}` })
          } catch (e) {
            await sock.sendMessage(OWNER_JID, { text: '❌ Gagal membaca logs.' })
          }
          return
        }

        // Unknown command
        await sock.sendMessage(OWNER_JID, { text: '❓ Command tidak dikenal. Ketik !help' })
        return
      }

      // End of private-owner-command handler

    } catch (err) {
      console.error('❌ Error pada messages.upsert handler:', err)
    }
  })

  // -----------------------------
  // SEND: hidden mention (single)
  // - groupId: id grup (g.us)
  // - targetJid: participant jid (number@s.whatsapp.net)
  // -----------------------------
  async function sendHiddenMention(groupId, targetJid, text) {
    try {
      await sock.sendMessage(groupId, {
        text,
        mentions: [targetJid]
      })
      safeLog(`✅ Pesan dengan mention tersembunyi terkirim ke ${groupId} (mention: ${targetJid})`)
    } catch (err) {
      console.error('Gagal mengirim hidden mention:', err)
    }
  }

  // -----------------------------
  // TAG ALL HIDDEN
  // - groupId: id grup
  // - text: pesan
  // -----------------------------
  async function tagAllHidden(groupId, text) {
    try {
      const metadata = await sock.groupMetadata(groupId)
      const participants = metadata.participants.map(p => p.id)
      await sock.sendMessage(groupId, {
        text,
        mentions: participants
      })
      safeLog(`✅ Tag all berhasil (${participants.length}) di grup ${metadata.subject}`)
    } catch (err) {
      console.error('Gagal tag all:', err)
    }
  }

  // -----------------------------
  // SEND FILE (works for image/video/audio/document)
  // - filePath can be absolute path on your laptop
  // -----------------------------
  async function sendFile(groupId, filePath, caption = '') {
    try {
      if (!fs.existsSync(filePath)) {
        safeLog(`⚠️ File tidak ditemukan: ${filePath}`)
        return
      }
      const mimeType = getMimeType(filePath)
      const buffer = fs.readFileSync(filePath)
      let content = {}
      if (mimeType.startsWith('image/')) content = { image: buffer, caption }
      else if (mimeType.startsWith('video/')) content = { video: buffer, caption }
      else if (mimeType.startsWith('audio/')) content = { audio: buffer, mimetype: mimeType, ptt: false }
      else content = { document: buffer, fileName: path.basename(filePath), caption }
      await sock.sendMessage(groupId, content)
      safeLog(`📤 File terkirim ke ${groupId}: ${path.basename(filePath)}`)
    } catch (err) {
      console.error('Gagal mengirim file:', err)
    }
  }

  // -----------------------------
  // SEND FILE + TAG ALL HIDDEN
  // -----------------------------
  async function sendFileTagAll(groupId, filePath, caption = '') {
    try {
      const metadata = await sock.groupMetadata(groupId)
      const participants = metadata.participants.map(p => p.id)
      if (!fs.existsSync(filePath)) {
        safeLog(`⚠️ File tidak ditemukan: ${filePath}`)
        return
      }
      const mimeType = getMimeType(filePath)
      const buffer = fs.readFileSync(filePath)
      let content = {}
      if (mimeType.startsWith('image/')) content = { image: buffer, caption, mentions: participants }
      else if (mimeType.startsWith('video/')) content = { video: buffer, caption, mentions: participants }
      else if (mimeType.startsWith('audio/')) content = { audio: buffer, mimetype: mimeType, ptt: false, mentions: participants }
      else content = { document: buffer, fileName: path.basename(filePath), caption, mentions: participants }
      await sock.sendMessage(groupId, content)
      safeLog(`📤 File + tagall terkirim ke grup ${metadata.subject}`)
    } catch (err) {
      console.error('Gagal kirim file dengan tag all:', err)
    }
  }

  // -----------------------------
  // Terminal (stdin) commands handler
  // - Keeps original terminal commands working
  // -----------------------------
  process.stdin.setEncoding('utf8')
  safeLog('\n🧩 Perintah cepat (terminal):')
  safeLog('• Tag orang di grup: groupId|628xxxxxxxxxx|Pesanmu')
  safeLog('• Tag semua: tagall|groupId|Pesanmu')
  safeLog('• Kirim file: file|groupId|C:\\path\\to\\file.jpg|Caption opsional')
  safeLog('• Kirim file tag all: filetag|groupId|C:\\path\\to\\file.jpg|Caption opsional')
  safeLog('• Reply pesan terakhir: reply|chatId|Pesanmu')
  safeLog('• Lihat grup: groups')
  safeLog('• Keluar: exit\n')

  process.stdin.on('data', async (data) => {
    try {
      const line = data.toString().trim()
      if (!line) return
      if (line.toLowerCase() === 'exit') process.exit(0)
      if (line.toLowerCase() === 'groups') return await listGroups(sock)

      const parts = line.split('|')

      // === Reply via terminal ===
      if (parts[0].toLowerCase() === 'reply' && parts.length >= 3) {
        const [, chatId, ...msgParts] = parts
        const msg = msgParts.join('|').trim()
        if (!lastMessages[chatId]) {
          safeLog(`⚠️ Belum ada pesan yang tersimpan dari chat: ${chatId}`)
          return
        }
        const isGroup = chatId.endsWith('@g.us')
        try {
          if (isGroup) {
            const metadata = await sock.groupMetadata(chatId)
            const participants = metadata.participants.map(p => p.id)
            await sock.sendMessage(chatId, { text: msg, quoted: lastMessages[chatId], mentions: participants })
            safeLog(`✅ Reply + Hide Tag All terkirim ke grup ${metadata.subject}`)
          } else {
            await sock.sendMessage(chatId, { text: msg, quoted: lastMessages[chatId] })
            safeLog(`✅ Reply terkirim ke chat pribadi ${chatId}`)
          }
        } catch (err) {
          console.error('❌ Gagal mengirim reply (terminal):', err)
        }
        return
      }

      // === Kirim file (terminal) ===
      if (parts[0].toLowerCase() === 'file' && parts.length >= 3) {
        const [, groupId, filePath, ...captionParts] = parts
        const caption = captionParts.join('|').trim()
        return await sendFile(groupId.trim(), filePath.trim(), caption)
      }

      // === Kirim file + tag all (terminal) ===
      if (parts[0].toLowerCase() === 'filetag' && parts.length >= 3) {
        const [, groupId, filePath, ...captionParts] = parts
        const caption = captionParts.join('|').trim()
        return await sendFileTagAll(groupId.trim(), filePath.trim(), caption)
      }

      // === Tag all (terminal) ===
      if (parts[0].toLowerCase() === 'tagall' && parts.length >= 3) {
        const [, groupId, ...msgParts] = parts
        const msg = msgParts.join('|').trim()
        return await tagAllHidden(groupId.trim(), msg)
      }

      // === Kirim mention (terminal) ===
      if (parts.length >= 3) {
        const [groupId, phone, ...msgParts] = parts
        const msg = msgParts.join('|').trim()
        const targetJid = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@s.whatsapp.net`
        return await sendHiddenMention(groupId.trim(), targetJid, msg)
      }

      safeLog('⚠️  Format salah. Lihat panduan perintah.')
    } catch (err) {
      console.error('❌ Error saat membaca input terminal:', err)
    }
  })

  // -----------------------------
  // listGroups function: tampilkan grup yg bot gabung
  // -----------------------------
  async function listGroups(sockInstance) {
    try {
      const groups = await sockInstance.groupFetchAllParticipating()
      const groupList = Object.values(groups)
      safeLog(`📚 Kamu tergabung di ${groupList.length} grup:`)
      groupList.forEach((g, i) => {
        safeLog(`${i + 1}. ${g.subject} (${g.id})`)
      })
    } catch (err) {
      console.error('Gagal menampilkan daftar grup:', err)
    }
  }

  // end start()
  return sock
}

// start bot and catch fatal errors
start().catch(err => console.error('❌ ERROR FATAL:', err))
