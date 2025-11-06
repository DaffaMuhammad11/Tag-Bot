// index.js
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} from '@whiskeysockets/baileys'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import fs from 'fs'
import path from 'path'

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./session')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    version
  })

  sock.ev.on('creds.update', saveCreds)

  // === HANDLE STATUS KONEKSI ===
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      qrcode.generate(qr, { small: true })
      console.log('📱 Scan QR dari WhatsApp kamu (Linked devices → Link a device).')
    }

    if (connection === 'open') {
      console.log('✅ Terhubung ke WhatsApp!\n')
      listGroups(sock)
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode
      console.log('❌ Koneksi terputus:', reason)

      if (reason !== DisconnectReason.loggedOut) {
        console.log('🔁 Mencoba menyambung ulang...')
        start()
      } else {
        console.log('🚪 Sesi kadaluarsa. Hapus folder "session" lalu jalankan ulang untuk scan QR baru.')
      }
    }
  })

  // === LOG PESAN MASUK ===
  sock.ev.on('messages.upsert', (m) => {
    try {
      const msg = m.messages?.[0]
      if (!msg || msg.key.fromMe) return

      const chatId = msg.key.remoteJid
      const sender = msg.key.participant || msg.key.remoteJid
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || ''

      const logText = `[${new Date().toLocaleString()}] Dari: ${sender} | Chat: ${chatId} | Pesan: ${text}\n`
      fs.appendFileSync('logs.txt', logText)
      console.log('💬', logText.trim())
    } catch (err) {
      console.error('Error logging message:', err)
    }
  })

  // === KIRIM PESAN DENGAN HIDDEN TAG ===
  async function sendHiddenMention(groupId, targetJid, text) {
    try {
      await sock.sendMessage(groupId, {
        text: text,
        mentions: [targetJid]
      })
      console.log(`✅ Pesan terkirim ke ${groupId} (mention ke ${targetJid})`)
    } catch (err) {
      console.error('Gagal mengirim pesan:', err)
    }
  }

  // === TAG ALL TANPA MENAMPILKAN NAMA ===
  async function tagAllHidden(groupId, text) {
    try {
      const metadata = await sock.groupMetadata(groupId)
      const participants = metadata.participants.map(p => p.id)

      await sock.sendMessage(groupId, {
        text: text,
        mentions: participants
      })

      console.log(`✅ Tag all berhasil (${participants.length} anggota) di grup ${metadata.subject}`)
    } catch (err) {
      console.error('Gagal tag all:', err)
    }
  }

  // === KIRIM FILE / LAMPIRAN ===
  async function sendFile(groupId, filePath, caption = '') {
    try {
      if (!fs.existsSync(filePath)) {
        console.log(`⚠️ File tidak ditemukan: ${filePath}`)
        return
      }

      const mimeType = getMimeType(filePath)
      const buffer = fs.readFileSync(filePath)

      let messageContent = {}

      if (mimeType.startsWith('image/')) {
        messageContent = { image: buffer, caption }
      } else if (mimeType.startsWith('video/')) {
        messageContent = { video: buffer, caption }
      } else if (mimeType.startsWith('audio/')) {
        messageContent = { audio: buffer, mimetype: 'audio/mp4', ptt: false }
      } else {
        messageContent = { document: buffer, fileName: path.basename(filePath), caption }
      }

      await sock.sendMessage(groupId, messageContent)
      console.log(`📤 File terkirim ke ${groupId}: ${path.basename(filePath)}`)
    } catch (err) {
      console.error('Gagal mengirim file:', err)
    }
  }

  // === KIRIM FILE DENGAN HIDE TAG ALL ===
  async function sendFileTagAll(groupId, filePath, caption = '') {
    try {
      const metadata = await sock.groupMetadata(groupId)
      const participants = metadata.participants.map(p => p.id)

      if (!fs.existsSync(filePath)) {
        console.log(`⚠️ File tidak ditemukan: ${filePath}`)
        return
      }

      const mimeType = getMimeType(filePath)
      const buffer = fs.readFileSync(filePath)
      let messageContent = {}

      if (mimeType.startsWith('image/')) {
        messageContent = { image: buffer, caption, mentions: participants }
      } else if (mimeType.startsWith('video/')) {
        messageContent = { video: buffer, caption, mentions: participants }
      } else if (mimeType.startsWith('audio/')) {
        messageContent = { audio: buffer, mimetype: 'audio/mp4', ptt: false, mentions: participants }
      } else {
        messageContent = { document: buffer, fileName: path.basename(filePath), caption, mentions: participants }
      }

      await sock.sendMessage(groupId, messageContent)
      console.log(`📤 File + tag all berhasil dikirim ke grup ${metadata.subject}`)
    } catch (err) {
      console.error('Gagal kirim file dengan tag all:', err)
    }
  }

  // === CEK MIME TYPE ===
  function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase()
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) return 'image/' + ext.slice(1)
    if (['.mp4', '.mkv', '.mov'].includes(ext)) return 'video/' + ext.slice(1)
    if (['.mp3', '.ogg', '.wav'].includes(ext)) return 'audio/' + ext.slice(1)
    return 'application/octet-stream'
  }

  // === INPUT TERMINAL ===
  process.stdin.setEncoding('utf8')
  console.log('\n🧩 Perintah cepat:')
  console.log('• Tag orang di grup: groupId|628xxxxxxxxxx|Pesanmu')
  console.log('• Tag semua: tagall|groupId|Pesanmu')
  console.log('• Kirim file: file|groupId|C:\\path\\to\\file.jpg|Caption opsional')
  console.log('• Kirim file tag all: filetag|groupId|C:\\path\\to\\file.jpg|Caption opsional')
  console.log('• Lihat grup: groups')
  console.log('• Keluar: exit\n')

  process.stdin.on('data', async (data) => {
    const line = data.toString().trim()
    if (!line) return

    if (line.toLowerCase() === 'exit') process.exit(0)
    if (line.toLowerCase() === 'groups') return await listGroups(sock)

    const parts = line.split('|')

    // === Kirim file ===
    if (parts[0].toLowerCase() === 'file' && parts.length >= 3) {
      const [_, groupId, filePath, ...captionParts] = parts
      const caption = captionParts.join('|').trim()
      return await sendFile(groupId.trim(), filePath.trim(), caption)
    }

    // === Kirim file + tag all ===
    if (parts[0].toLowerCase() === 'filetag' && parts.length >= 3) {
      const [_, groupId, filePath, ...captionParts] = parts
      const caption = captionParts.join('|').trim()
      return await sendFileTagAll(groupId.trim(), filePath.trim(), caption)
    }

    // === Tag all ===
    if (parts[0].toLowerCase() === 'tagall' && parts.length >= 3) {
      const [_, groupId, ...msgParts] = parts
      const msg = msgParts.join('|').trim()
      return await tagAllHidden(groupId.trim(), msg)
    }

    // === Kirim mention ===
    if (parts.length >= 3) {
      const [groupId, phone, ...msgParts] = parts
      const msg = msgParts.join('|').trim()
      const targetJid = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@s.whatsapp.net`
      return await sendHiddenMention(groupId.trim(), targetJid, msg)
    }

    console.log('⚠️  Format salah. List Command:\n• Tag orang di grup: groupId|628xxxxxxxxxx|Pesanmu\n• Tag semua: tagall|groupId|Pesanmu\n• Kirim file: file|groupId|C:\\path\\to\\file.jpg|Caption opsional\n• Kirim file tag all: filetag|groupId|C:\\path\\to\\file.jpg|Caption opsional\n• Lihat grup: groups\n• Keluar: exit')
  })
}

// === MENAMPILKAN DAFTAR GRUP ===
async function listGroups(sock) {
  try {
    const groups = await sock.groupFetchAllParticipating()
    const groupList = Object.values(groups)
    console.log(`📚 Kamu tergabung di ${groupList.length} grup:`)
    groupList.forEach((g, i) => {
      console.log(`${i + 1}. ${g.subject} (${g.id})`)
    })
  } catch (err) {
    console.error('Gagal menampilkan daftar grup:', err)
  }
}

start().catch(err => console.error('❌ ERROR FATAL:', err))


