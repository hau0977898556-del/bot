require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { executeInSandbox } = require('./Sandbox/executor.js');
const sandboxWhitelist = require('./Sandbox/whitelist.js');
const { ensureUserSandbox } = require('./Sandbox/manager.js');
const { 
    Client, 
    GatewayIntentBits, 
    Events, 
    EmbedBuilder, 
    AuditLogEvent,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    ChannelType,
    Partials,
    REST,
    Routes,
    SlashCommandBuilder,
    PermissionFlagsBits,
    AttachmentBuilder
} = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    StreamType,
    entersState,
    getVoiceConnection
} = require('@discordjs/voice');
const ffmpegPath = require('ffmpeg-static');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildEmojisAndStickers,
        GatewayIntentBits.GuildPresences, // cần để check member.presence.status (Checksuspicious rule B)
        GatewayIntentBits.GuildVoiceStates, // cần để join voice/stage cho &&play
    ],
    // Partials cần cho MessageDelete/MessageUpdate của tin nhắn ko nằm sẵn
    // trong cache (vd bot mới restart) - ko có cái này thì /snipe sẽ miss
    // khá nhiều trường hợp xoá/sửa.
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

const ADMIN_ID = process.env.ADMIN_ID || '1249558116761342016';
const CLIENT_ID = process.env.CLIENT_ID || '1536323660581707776';
const EXEMPT_ROLE_ID = '1536934629330911242'; // Role miễn phạt (CHỈ áp dụng cho weekly inactivity purge, xem canModerateTarget)
const ACTIVITY_FILE = path.join(__dirname, 'activity_data.json');
const ANTISNIPE_CONFIG_FILE = path.join(__dirname, 'antisnipe_config.json'); // config chung toàn bot (ko theo từng server)
const SNIPE_LIMIT = 20; // số tin nhắn xoá/sửa gần nhất lưu lại mỗi channel
const SOCLIP_API_KEY = process.env.SOCLIP_API_KEY || 'sc_live_3c0bda4efa3c9270290759e07a40de13';
const SOCLIP_API_URL = 'https://api.soclip.dev/v1/media';
const DISCORD_UPLOAD_LIMIT = 10 * 1024 * 1024; // 10MB, giới hạn upload mặc định (server ko có boost)

let lastRequestTime = 0; 
let currentAiMode = 'deepseek';

// ==========================================
// API LẤY NGÀY GIỜ VIỆT NAM (UTC+7)
// ==========================================
const crypto = require('node:crypto'); // Thêm chữ 'node:' đằng trước
async function getVietnamTimeInfo() {
    try {
        const res = await fetch("https://timeapi.io/api/time/current/zone?timeZone=Asia/Ho_Chi_Minh");
        if (res.ok) {
            const data = await res.json();
            return {
                year: data.year,
                month: String(data.month).padStart(2, '0'),
                day: String(data.day).padStart(2, '0'),
                hour: data.hour,
                minute: data.minute,
                weekday: data.dayOfWeek
            };
        }
    } catch (e) {}

    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Ho_Chi_Minh',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: 'numeric', minute: '2-digit', hour12: false,
        weekday: 'long'
    });
    const parts = formatter.formatToParts(new Date());
    const dateObj = {};
    parts.forEach(p => { if (p.type !== 'literal') dateObj[p.type] = p.value; });

    return {
        year: parseInt(dateObj.year),
        month: dateObj.month,
        day: dateObj.day,
        hour: parseInt(dateObj.hour),
        minute: parseInt(dateObj.minute),
        weekday: dateObj.weekday
    };
}

// ==========================================
// HÀM XỬ LÝ FILE DỮ LIỆU ĐẾM CHAT
// ==========================================

function loadActivityData() {
    try {
        if (fs.existsSync(ACTIVITY_FILE)) {
            const data = fs.readFileSync(ACTIVITY_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (err) {
        console.error("Error loading activity data file:", err);
    }
    return { lastPurgeDate: "", users: {} };
}

function saveActivityData(data) {
    try {
        fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error("Error saving activity data file:", err);
    }
}

function normalizeText(text) {
    if (!text) return "";
    return text
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/đ/g, "d")
        .replace(/Đ/g, "d")
        .trim();
}

// ==========================================
// SOCLIP API - lấy link video/audio gốc từ TikTok/YouTube
// Dùng chung cho &&vid (gửi file video) và &&play (tách mp3 phát voice).
// ==========================================
function isSupportedVideoLink(text) {
    return /https?:\/\/(www\.|vt\.|vm\.)?(tiktok\.com|youtube\.com|youtu\.be)\/\S+/i.test(text);
}

async function fetchSoclipMedia(url) {
    const res = await fetch(SOCLIP_API_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${SOCLIP_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ url })
    });

    let json;
    try {
        json = await res.json();
    } catch (e) {
        throw new Error(`Soclip API trả về response ko hợp lệ (HTTP ${res.status}).`);
    }

    if (!res.ok || !json.success) {
        throw new Error(json?.error || json?.message || `Soclip API lỗi (HTTP ${res.status}).`);
    }

    return json.data;
}

// Chọn media chất lượng cao nhất trong danh sách medias trả về (ưu tiên
// độ phân giải cao nhất, mp4 trước, fallback về phần tử đầu tiên nếu ko
// tìm được kích thước để so sánh).
function pickBestMedia(medias) {
    if (!medias || medias.length === 0) return null;
    const sorted = [...medias].sort((a, b) => {
        const areaA = (a.width || 0) * (a.height || 0);
        const areaB = (b.width || 0) * (b.height || 0);
        return areaB - areaA;
    });
    return sorted[0];
}

// Tải 1 URL về path chỉ định trên đĩa (dùng cho cả &&vid lẫn &&play).
async function downloadToFile(url, destPath) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Tải file thất bại (HTTP ${res.status}).`);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destPath, buffer);
    return destPath;
}

// ==========================================
// SNIPE / ANTI-SNIPE
// ==========================================
// snipeCache: Map<channelId, Array<entry>> - lưu tối đa SNIPE_LIMIT tin nhắn
// xoá/sửa gần nhất mỗi channel, entry mới nhất ở CUỐI mảng. Chỉ sống trong
// RAM (mất khi restart bot) - đúng tinh thần "snipe" bình thường, ko cần
// persist ra file.
const snipeCache = new Map();

function pushSnipeEntry(channelId, entry) {
    if (!snipeCache.has(channelId)) snipeCache.set(channelId, []);
    const arr = snipeCache.get(channelId);
    arr.push(entry);
    if (arr.length > SNIPE_LIMIT) arr.shift(); // bỏ cái cũ nhất
}

function loadAntiSnipeConfig() {
    try {
        if (fs.existsSync(ANTISNIPE_CONFIG_FILE)) {
            return JSON.parse(fs.readFileSync(ANTISNIPE_CONFIG_FILE, 'utf8'));
        }
    } catch (err) {
        console.error("Error loading anti-snipe config:", err);
    }
    return { enabled: false };
}

function saveAntiSnipeConfig(cfg) {
    try {
        fs.writeFileSync(ANTISNIPE_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
    } catch (err) {
        console.error("Error saving anti-snipe config:", err);
    }
}

// Anti-snipe CHỈ có tác dụng với người có role THẤP HƠN bot (member thường).
// Với người có role CAO HƠN/BẰNG bot (admin/mod cấp cao), /snipe vẫn hiện
// bình thường dù anti-snipe đang bật - vì bot ko thể "giấu" thông tin với
// cấp quản lý cao hơn chính nó.
async function isAboveBotHierarchy(guild, userId) {
    try {
        const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
        if (!botMember) return false;
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) return false;
        if (member.id === guild.ownerId) return true;
        return member.roles.highest.position >= botMember.roles.highest.position;
    } catch (err) {
        console.error("❌ Lỗi check hierarchy cho anti-snipe:", err);
        return false;
    }
}

client.on(Events.MessageDelete, (message) => {
    try {
        if (!message.guild) return;
        if (message.author?.bot) return;
        if (!message.content && message.attachments.size === 0) return; // ko có gì để snipe (vd embed-only, hoặc content ko cache được)

        pushSnipeEntry(message.channel.id, {
            type: 'delete',
            authorId: message.author?.id || null,
            authorTag: message.author?.tag || 'Unknown',
            authorAvatar: message.author?.displayAvatarURL?.() || null,
            content: message.content || '',
            attachments: [...message.attachments.values()].map(a => ({ name: a.name, url: a.url })),
            createdTimestamp: message.createdTimestamp || Date.now(),
            deletedTimestamp: Date.now()
        });
    } catch (err) {
        console.error("❌ Lỗi lưu snipe (delete):", err);
    }
});

client.on(Events.MessageBulkDelete, (messages) => {
    try {
        for (const message of messages.values()) {
            if (!message.guild) continue;
            if (message.author?.bot) continue;
            if (!message.content && message.attachments.size === 0) continue;

            pushSnipeEntry(message.channel.id, {
                type: 'delete',
                authorId: message.author?.id || null,
                authorTag: message.author?.tag || 'Unknown',
                authorAvatar: message.author?.displayAvatarURL?.() || null,
                content: message.content || '',
                attachments: [...message.attachments.values()].map(a => ({ name: a.name, url: a.url })),
                createdTimestamp: message.createdTimestamp || Date.now(),
                deletedTimestamp: Date.now()
            });
        }
    } catch (err) {
        console.error("❌ Lỗi lưu snipe (bulk delete):", err);
    }
});

client.on(Events.MessageUpdate, (oldMessage, newMessage) => {
    try {
        if (!newMessage.guild) return;
        if (newMessage.author?.bot) return;
        // Nếu ko có nội dung cũ (message partial chưa cache) thì ko có gì để so sánh/snipe
        if (oldMessage.content === null || oldMessage.content === undefined) return;
        if (oldMessage.content === newMessage.content) return; // sửa embed/reaction..., ko phải sửa nội dung

        pushSnipeEntry(newMessage.channel.id, {
            type: 'edit',
            authorId: newMessage.author?.id || null,
            authorTag: newMessage.author?.tag || 'Unknown',
            authorAvatar: newMessage.author?.displayAvatarURL?.() || null,
            oldContent: oldMessage.content || '',
            newContent: newMessage.content || '',
            attachments: [...newMessage.attachments.values()].map(a => ({ name: a.name, url: a.url })),
            createdTimestamp: newMessage.createdTimestamp || Date.now(),
            editedTimestamp: Date.now(),
            jumpUrl: newMessage.url
        });
    } catch (err) {
        console.error("❌ Lỗi lưu snipe (edit):", err);
    }
});

// ==========================================
// &&play - MUSIC QUEUE (mỗi guild 1 queue riêng)
// ==========================================
// musicQueues: Map<guildId, { connection, player, textChannelId, tracks: [], playing }>
// tracks[]: { title, author, filePath, requestedBy }
const musicQueues = new Map();

function getQueue(guildId) {
    return musicQueues.get(guildId) || null;
}

function getOrCreateQueue(guildId, textChannelId) {
    let q = musicQueues.get(guildId);
    if (!q) {
        q = {
            connection: null,
            player: null,
            textChannelId,
            tracks: [],
            playing: false
        };
        musicQueues.set(guildId, q);
    }
    return q;
}

// Dọn sạch queue + rời voice + xoá file mp3 tạm còn sót (tránh rác tích
// luỹ trong Sandbox/<userId>/work qua thời gian).
function destroyQueue(guildId) {
    const q = musicQueues.get(guildId);
    if (!q) return;
    try {
        for (const track of q.tracks) {
            if (track.filePath && fs.existsSync(track.filePath)) {
                fs.unlink(track.filePath, () => {});
            }
        }
        if (q.player) q.player.stop(true);
        if (q.connection) q.connection.destroy();
    } catch (err) {
        console.error("❌ Lỗi dọn dẹp music queue:", err);
    }
    musicQueues.delete(guildId);
}

function playNextInQueue(guildId) {
    const q = musicQueues.get(guildId);
    if (!q) return;

    const track = q.tracks[0];
    if (!track) {
        // Hết queue -> rời voice sau 1 khoảng ngắn thay vì leave ngay lập tức,
        // để lỡ user &&play tiếp bài mới thì ko phải join lại từ đầu.
        q.playing = false;
        setTimeout(() => {
            const stillQ = musicQueues.get(guildId);
            if (stillQ && stillQ.tracks.length === 0 && !stillQ.playing) {
                destroyQueue(guildId);
            }
        }, 60 * 1000);
        return;
    }

    q.playing = true;
    try {
        // Chất lượng âm thanh tối đa: decode PCM 48kHz stereo qua ffmpeg thay
        // vì để @discordjs/voice tự transcode mp3 (đảm bảo bitrate/output nhất
        // quán, tận dụng Opus 48kHz mà Discord voice dùng nội bộ).
        const resource = createAudioResource(track.filePath, {
            inputType: StreamType.Arbitrary,
            inlineVolume: false
        });
        q.player.play(resource);
    } catch (err) {
        console.error("❌ Lỗi phát track:", err);
        q.tracks.shift();
        playNextInQueue(guildId);
    }
}

// Convert file media (mp4/webm) tải từ soclip sang mp3 bằng ffmpeg-static,
// lưu trong chính thư mục work của sandbox user đã request (tận dụng
// storage sẵn có, ko tạo thêm thư mục riêng ngoài quy ước sandbox).
function convertToMp3(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        execFile(ffmpegPath, [
            '-y',
            '-i', inputPath,
            '-vn',
            '-acodec', 'libmp3lame',
            '-q:a', '0', // VBR chất lượng cao nhất cho mp3
            outputPath
        ], (err) => {
            if (err) return reject(err);
            resolve(outputPath);
        });
    });
}

// ==========================================
// TIẾN HÀNH QUÉT BAN VÀO 8H00 SÁNG THỨ 2 HÀNG TUẦN
// ==========================================

async function checkWeeklyInactivityPurge() {
    const vt = await getVietnamTimeInfo();
    const todayDateStr = `${vt.year}-${vt.month}-${vt.day}`;

    let activityData = loadActivityData();

    if (vt.weekday === "Monday" && vt.hour >= 8 && activityData.lastPurgeDate !== todayDateStr) {
        console.log(`⏰ [SCHEDULED PURGE] Running weekly purge at ${vt.hour}:${vt.minute} VN Time on Monday (${todayDateStr})...`);

        for (const guild of client.guilds.cache.values()) {
            try {
                const members = await guild.members.fetch();

                for (const [memberId, member] of members) {
                    if (member.user.bot) continue;
                    if (member.id === guild.ownerId) continue;
                    if (member.roles.cache.has(EXEMPT_ROLE_ID)) continue;

                    const userChatCount = activityData.users[memberId]?.count || 0;

                    if (userChatCount < 40) {
                        try {
                            const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
                            
                            if (botMember && member.roles.highest.position < botMember.roles.highest.position) {
                                await member.ban({ reason: `Weekly Inactivity Purge: Less than 40 chats (${userChatCount}/40)` });
                                console.log(`[PURGED] Banned ${member.user.tag} (${member.id}) - Chat Count: ${userChatCount}`);

                                const logChannel = await client.channels.fetch(process.env.LOG_CHANNEL_ID).catch(() => null);
                                if (logChannel) {
                                    const embed = new EmbedBuilder()
                                        .setTitle('Inactivity Purge')
                                        .setColor(0x800080)
                                        .addFields(
                                            { name: 'User', value: `${member.user.tag} (<@${member.id}>)`, inline: true },
                                            { name: 'Chat Count', value: `${userChatCount} / 40 chats`, inline: true },
                                            { name: 'Reason', value: 'Failed to reach 40 valid messages in 1 week.', inline: false }
                                        )
                                        .setTimestamp();
                                    logChannel.send({ embeds: [embed] });
                                }
                            }
                        } catch (e) {
                            console.error(`Failed to ban ${member.user.tag}:`, e.message);
                        }
                    }
                }
            } catch (e) {
                console.error(`Error purging guild ${guild.name}:`, e.message);
            }
        }

        activityData.lastPurgeDate = todayDateStr;
        activityData.users = {};
        saveActivityData(activityData);
        console.log(`✅ [SCHEDULED PURGE] Complete! Reset activity tracker for the new week.`);
    }
}

// CHAT SESSION MEMORY
const userSessions = new Map();
const MAX_HISTORY_MESSAGES = 10; 

// ==========================================
// SLASH COMMANDS: /snipe, /anti-snipe
// ==========================================
const slashCommands = [
    new SlashCommandBuilder()
        .setName('snipe')
        .setDescription('Xem tin nhắn vừa bị xoá/sửa gần nhất trong channel này')
        .addIntegerOption(opt =>
            opt.setName('index')
                .setDescription('Thứ tự tin nhắn muốn xem (1 = gần nhất nhất). Mặc định 1.')
                .setMinValue(1)
                .setMaxValue(SNIPE_LIMIT)
        ),
    new SlashCommandBuilder()
        .setName('anti-snipe')
        .setDescription('Bật/tắt anti-snipe (chặn /snipe với người có role thấp hơn bot) - áp dụng toàn bot')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addBooleanOption(opt =>
            opt.setName('enable')
                .setDescription('true = bật, false = tắt')
                .setRequired(true)
        )
].map(cmd => cmd.toJSON());

async function registerSlashCommands() {
    try {
        const rest = new REST().setToken(process.env.DISCORD_TOKEN);
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: slashCommands });
        console.log(`✅ Đã đăng ký ${slashCommands.length} slash command(s) (global).`);
    } catch (err) {
        console.error("❌ Lỗi đăng ký slash command:", err);
    }
}

client.once(Events.ClientReady, async (c) => {
    console.log(`🤖 Bot is online as: ${c.user.tag}`);
    
    await registerSlashCommands();

    await checkWeeklyInactivityPurge();
    setInterval(checkWeeklyInactivityPurge, 60 * 1000);
});

// ==========================================
// 1. MODERATION LOG NOTIFICATIONS
// ==========================================

client.on(Events.GuildBanAdd, async (ban) => {
    try {
        const logChannel = await client.channels.fetch(process.env.LOG_CHANNEL_ID).catch(() => null);
        if (!logChannel) return;

        await new Promise(res => setTimeout(res, 1000));

        const fetchedLogs = await ban.guild.fetchAuditLogs({ limit: 5, type: AuditLogEvent.GuildBanAdd }).catch(() => null);
        const banLog = fetchedLogs?.entries.find(entry => entry.target?.id === ban.user.id);

        const executor = banLog?.executor ? `${banLog.executor.tag} (<@${banLog.executor.id}>)` : 'Unknown';
        const reason = ban.reason || banLog?.reason || 'No reason provided';

        const embed = new EmbedBuilder()
            .setTitle('<:banned:1538549783482863729> Banned')
            .setColor(0xFF0000)
            .addFields(
                { name: 'User', value: `${ban.user.tag} (<@${ban.user.id}>)`, inline: true },
                { name: 'Banned By', value: `${executor}`, inline: true },
                { name: 'Reason', value: reason, inline: false }
            )
            .setTimestamp();

        logChannel.send({ embeds: [embed] });
    } catch (err) {
        console.error("Ban Log Error:", err);
    }
});

client.on(Events.GuildBanRemove, async (ban) => {
    try {
        const logChannel = await client.channels.fetch(process.env.LOG_CHANNEL_ID).catch(() => null);
        if (!logChannel) return;

        await new Promise(res => setTimeout(res, 1000));

        const fetchedLogs = await ban.guild.fetchAuditLogs({ limit: 5, type: AuditLogEvent.GuildBanRemove }).catch(() => null);
        const unbanLog = fetchedLogs?.entries.find(entry => entry.target?.id === ban.user.id);

        const executor = unbanLog?.executor ? `${unbanLog.executor.tag} (<@${unbanLog.executor.id}>)` : 'Unknown';
        const reason = unbanLog?.reason || 'No reason provided';

        const embed = new EmbedBuilder()
            .setTitle('<:banned:1538549783482863729> Unbanned <:banned:1538549783482863729>')
            .setColor(0x00FF00)
            .addFields(
                { name: 'User', value: `${ban.user.tag} (<@${ban.user.id}>)`, inline: true },
                { name: 'Unbanned By', value: `${executor}`, inline: true },
                { name: 'Reason', value: reason, inline: false }
            )
            .setTimestamp();

        logChannel.send({ embeds: [embed] });
    } catch (err) {
        console.error("Unban Log Error:", err);
    }
});

// ==========================================
// HỆ THỐNG FLAG NGHI VẤN (điểm cộng dồn nhiều rule, chỉ để admin xem tay)
// ==========================================
// Toàn bộ logic tính điểm nằm ở ./Checksuspicious/filter.js, state lưu ở
// ./Checksuspicious/log.json (sống sót qua restart bot).
const suspiciousFilter = require('./Checksuspicious/filter.js');

async function notifyIfFlagged(entry, discordUser, guild) {
    if (entry.flagged) return;
    if (entry.score < suspiciousFilter.FLAG_SCORE_THRESHOLD) return;

    entry.flagged = true;

    try {
        const admin = await client.users.fetch(ADMIN_ID).catch(() => null);
        if (!admin) return;

        const reasonsText = entry.reasons.map((r, i) => `${i + 1}. ${r}`).join('\n');

        const flagEmbed = new EmbedBuilder()
            .setTitle('🚩 Flag nghi vấn')
            .setColor(0xFFA500)
            .setDescription(
                `**User:** ${discordUser.tag} (<@${discordUser.id}>)\n` +
                `**Server:** ${guild?.name || 'N/A'}\n` +
                `**Tổng điểm nghi vấn:** ${entry.score}\n\n` +
                `**Lý do:**\n${reasonsText}\n\n` +
                `⚠️ Đây chỉ là cảnh báo tự động dựa trên heuristic, KHÔNG phải bằng chứng khẳng định gì cả. Tự xem xét context/tin nhắn thực tế trước khi quyết định.`
            )
            .setTimestamp();

        await admin.send({ embeds: [flagEmbed] });
    } catch (err) {
        console.error("❌ Lỗi gửi flag cho admin:", err);
    }
}

async function checkSuspiciousOnMessage(message) {
    const data = suspiciousFilter.loadLog();
    const entry = suspiciousFilter.getOrCreateEntry(data, message.author.id, message.guild.id, message.member?.joinedTimestamp);

    if (entry.flagged) return; // đã báo rồi thì thôi, ko cần track tiếp nữa

    entry.lastMessageAt = Date.now(); // có chat -> reset đồng hồ "im lặng" cho rule C

    suspiciousFilter.checkQuestionSpam(entry, message.content);

    suspiciousFilter.saveLog(data);
    await notifyIfFlagged(entry, message.author, message.guild);
}

// RULE B + D: khi 1 member vừa được thêm role "Member" -> check status online + acc lâu năm/badge
async function checkSuspiciousOnMemberRoleAdd(oldMember, newMember) {
    const memberRole = newMember.guild.roles.cache.find(r => r.name === suspiciousFilter.MEMBER_ROLE_NAME);
    if (!memberRole) return; // ko tìm thấy role tên "Member" trong server -> bỏ qua

    const hadRoleBefore = oldMember.roles.cache.has(memberRole.id);
    const hasRoleNow = newMember.roles.cache.has(memberRole.id);
    if (hadRoleBefore || !hasRoleNow) return; // chỉ quan tâm lúc VỪA được thêm role

    const data = suspiciousFilter.loadLog();
    const entry = suspiciousFilter.getOrCreateEntry(data, newMember.id, newMember.guild.id, newMember.joinedTimestamp);
    if (entry.flagged) return;

    const presenceStatus = newMember.presence?.status || null;
    suspiciousFilter.checkMemberRoleOffline(entry, presenceStatus);
    suspiciousFilter.checkOldAccountNoBadges(entry, newMember.user);

    suspiciousFilter.saveLog(data);
    await notifyIfFlagged(entry, newMember.user, newMember.guild);
}

client.on(Events.GuildMemberAdd, (member) => {
    const data = suspiciousFilter.loadLog();
    suspiciousFilter.getOrCreateEntry(data, member.id, member.guild.id, member.joinedTimestamp || Date.now());
    suspiciousFilter.saveLog(data);
});

// Check định kỳ RULE C (3 ngày liền ko chat) cho toàn bộ user đang track
setInterval(async () => {
    try {
        const data = suspiciousFilter.loadLog();
        let changed = false;

        for (const [userId, entry] of Object.entries(data.users)) {
            if (entry.flagged) continue;
            const triggered = suspiciousFilter.checkNoChatStreak(entry);
            if (triggered) changed = true;

            if (entry.score >= suspiciousFilter.FLAG_SCORE_THRESHOLD && !entry.flagged) {
                const discordUser = await client.users.fetch(userId).catch(() => null);
                const guild = entry.guildId ? await client.guilds.fetch(entry.guildId).catch(() => null) : null;
                if (discordUser) await notifyIfFlagged(entry, discordUser, guild);
            }
        }

        if (changed) suspiciousFilter.saveLog(data);
    } catch (err) {
        console.error("❌ Lỗi check định kỳ no-chat-streak:", err);
    }
}, 6 * 60 * 60 * 1000); // mỗi 6 tiếng

client.on(Events.GuildMemberRemove, async (member) => {
    try {
        const logChannel = await client.channels.fetch(process.env.LOG_CHANNEL_ID).catch(() => null);
        if (!logChannel) return;

        await new Promise(res => setTimeout(res, 1000));

        const fetchedLogs = await member.guild.fetchAuditLogs({ limit: 5, type: AuditLogEvent.MemberKick }).catch(() => null);
        const kickLog = fetchedLogs?.entries.find(entry => entry.target?.id === member.id && (Date.now() - entry.createdTimestamp < 10000));

        if (!kickLog) return;

        const executor = kickLog.executor ? `${kickLog.executor.tag} (<@${kickLog.executor.id}>)` : 'Unknown';
        const reason = kickLog.reason || 'No reason provided';

        const embed = new EmbedBuilder()
            .setTitle('Kicked')
            .setColor(0xFFA500)
            .addFields(
                { name: 'User', value: `${member.user.tag} (<@${member.id}>)`, inline: true },
                { name: 'Kicked By', value: `${executor}`, inline: true },
                { name: 'Reason', value: reason, inline: false }
            )
            .setTimestamp();

        logChannel.send({ embeds: [embed] });
    } catch (err) {
        console.error("Kick Log Error:", err);
    }
});

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
    try {
        // Rule B + D (nghi vấn): check ngay khi vừa được add role Member,
        // đặt TRƯỚC early-return của logChannel bên dưới để ko bị bỏ qua
        // nếu server chưa cấu hình LOG_CHANNEL_ID.
        checkSuspiciousOnMemberRoleAdd(oldMember, newMember).catch(err =>
            console.error("❌ Lỗi checkSuspiciousOnMemberRoleAdd:", err)
        );

        const wasBoosting = oldMember.premiumSince;
        const isBoosting = newMember.premiumSince;

        if (!wasBoosting && isBoosting) {
            const boostChannel = await client.channels.fetch(process.env.BOOST_CHANNEL_ID).catch(() => null);
            if (boostChannel) {
                const totalBoosts = newMember.guild.premiumSubscriptionCount || 1;
                const boostLevel = newMember.guild.premiumTier || 0;

                const embed = new EmbedBuilder()
                    .setTitle('Thanks!')
                    .setColor(0xF47FFF)
                    .setDescription(`Thank you so much <@${newMember.id}> for boosting the server! 🎉<:jakibietbay:1538549949179101228>`)
                    .addFields(
                        { name: '👤 Booster', value: `${newMember.user.tag}`, inline: true },
                        { name: '💎 Total Boosts', value: `${totalBoosts} Boost(s)`, inline: true },
                        { name: '⭐ Server Tier', value: `Level ${boostLevel}`, inline: true }
                    )
                    .setThumbnail(newMember.user.displayAvatarURL({ dynamic: true }))
                    .setTimestamp();

                boostChannel.send({ content: `Huge thanks to <@${newMember.id}> for the boost!<:jakibietbay:1538549949179101228>`, embeds: [embed] });
            }
        }

        const oldTimeout = oldMember.communicationDisabledUntilTimestamp;
        const newTimeout = newMember.communicationDisabledUntilTimestamp;

        const logChannel = await client.channels.fetch(process.env.LOG_CHANNEL_ID).catch(() => null);
        if (!logChannel) return;

        if (newTimeout && newTimeout > Date.now() && newTimeout !== oldTimeout) {
            await new Promise(res => setTimeout(res, 1000));

            const fetchedLogs = await newMember.guild.fetchAuditLogs({ limit: 5, type: AuditLogEvent.MemberUpdate }).catch(() => null);
            
            const muteLog = fetchedLogs?.entries.find(entry => 
                entry.target?.id === newMember.id && 
                entry.changes?.some(change => change.key === 'communication_disabled_until')
            );

            const executor = muteLog?.executor ? `${muteLog.executor.tag} (<@${muteLog.executor.id}>)` : 'Unknown';
            const reason = muteLog?.reason || 'No reason provided';
            const durationMinutes = Math.round((newTimeout - Date.now()) / 60000);

            const embed = new EmbedBuilder()
                .setTitle('<:muted:1538550303023169597> Muted <:muted:1538550303023169597>')
                .setColor(0xFFFF00)
                .addFields(
                    { name: 'User', value: `${newMember.user.tag} (<@${newMember.id}>)`, inline: true },
                    { name: 'Duration', value: `${durationMinutes} minute(s)`, inline: true },
                    { name: 'Muted By', value: `${executor}`, inline: true },
                    { name: 'Reason', value: reason, inline: false }
                )
                .setTimestamp();

            logChannel.send({ embeds: [embed] });
        }

        if (oldTimeout && oldTimeout > Date.now() && (!newTimeout || newTimeout <= Date.now())) {
            await new Promise(res => setTimeout(res, 1000));

            const fetchedLogs = await newMember.guild.fetchAuditLogs({ limit: 5, type: AuditLogEvent.MemberUpdate }).catch(() => null);
            
            const unmuteLog = fetchedLogs?.entries.find(entry => 
                entry.target?.id === newMember.id && 
                entry.changes?.some(change => change.key === 'communication_disabled_until') &&
                (Date.now() - entry.createdTimestamp < 10000)
            );

            const executor = unmuteLog?.executor 
                ? `${unmuteLog.executor.tag} (<@${unmuteLog.executor.id}>)` 
                : 'System (Timeout Expired)';
                
            const reason = unmuteLog?.reason || 'Mute duration expired automatically';

            const embed = new EmbedBuilder()
                .setTitle('<:muted:1538550303023169597> Unmuted / Timeout Expired <:muted:1538550303023169597>')
                .setColor(0x00FF00)
                .addFields(
                    { name: 'User', value: `${newMember.user.tag} (<@${newMember.id}>)`, inline: true },
                    { name: 'Unmuted By', value: `${executor}`, inline: true },
                    { name: 'Reason', value: reason, inline: false }
                )
                .setTimestamp();

            logChannel.send({ embeds: [embed] });
        }

    } catch (err) {
        console.error("GuildMemberUpdate Event Error:", err);
    }
});


// ==========================================
// 2. MESSAGE COMMANDS & CHAT TRACKER
// ==========================================

client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;

    // ------------------------------------------
    // &&approve / &&deny <module> - CHỈ hoạt động trong DM từ Zeraa, dùng để
    // duyệt/từ chối module AI đề xuất cho code sandbox (Sandbox/whitelist.js)
    // ------------------------------------------
    if (!message.guild && message.author.id === ADMIN_ID &&
        (message.content.startsWith('&&approve ') || message.content.startsWith('&&deny '))) {
        const args = message.content.trim().split(/\s+/);
        const cmd = args[0].replace('&&', '');
        const moduleName = args[1];

        if (!moduleName) {
            return message.reply(`⚠️ **Cách dùng:** \`&&${cmd} <tên module>\``);
        }

        const result = cmd === 'approve'
            ? sandboxWhitelist.approveModule(moduleName)
            : sandboxWhitelist.denyModule(moduleName);

        return message.reply(result.message);
    }

    // ------------------------------------------
    // UPLOAD FILE -> lưu vào Sandbox/<userId>/uploaded/ (chỉ Admin, tránh
    // mọi member trong server đều tự ý nhồi file vào sandbox của bot)
    // ------------------------------------------
    if (message.author.id === ADMIN_ID && message.attachments.size > 0) {
        try {
            const { uploaded } = ensureUserSandbox(message.author.id);
            const savedFiles = [];

            for (const attachment of message.attachments.values()) {
                // Chặn upload file quá lớn để tránh sandbox phình to vô tội vạ
                if (attachment.size > 10 * 1024 * 1024) {
                    await message.reply(`⚠️ File **${attachment.name}** quá 10MB, bỏ qua.`);
                    continue;
                }

                const safeName = attachment.name.replace(/[/\\?%*:|"<>]/g, '_');
                const destPath = path.join(uploaded, safeName);

                const res = await fetch(attachment.url);
                const buffer = Buffer.from(await res.arrayBuffer());
                fs.writeFileSync(destPath, buffer);
                savedFiles.push(safeName);
            }
        } catch (err) {
            console.error("❌ Lỗi lưu file upload vào sandbox:", err);
            await message.reply(`Lỗi khi lưu file: \`${err.message}\``);
        }
    }

    // ĐẾM LƯỢT CHAT (CÓ LỌC CÂU LẶP)
    if (message.guild) {
        const userId = message.author.id;
        const normContent = normalizeText(message.content);

        if (normContent.length > 0) {
            let activityData = loadActivityData();
            
            if (!activityData.users[userId]) {
                activityData.users[userId] = { count: 0, lastMsg: "" };
            }

            const userStats = activityData.users[userId];

            if (userStats.lastMsg !== normContent) {
                userStats.count += 1;
                userStats.lastMsg = normContent;
                saveActivityData(activityData);
            }
        }
    }

    // FLAG NGHI VẤN: cập nhật lastMessageAt + check rule A (hỏi dồn dập lúc mới join)
    if (message.guild) {
        checkSuspiciousOnMessage(message).catch(err => console.error("❌ Lỗi checkSuspiciousOnMessage:", err));
    }

    // ------------------------------------------
    // MINI GAME: &&tx (TÀI XỈU)
    // ------------------------------------------
    if (message.content.startsWith('&&tx') || message.content.startsWith('&&taixiu')) {
        const args = message.content.trim().split(/\s+/);
        let choice = args[1]?.toLowerCase();

        if (choice === 't') choice = 'tai';
        if (choice === 'x') choice = 'xiu';

        if (!choice || (choice !== 'tai' && choice !== 'xiu')) {
            return message.reply("🎲 **Cách chơi Tài Xỉu:**\n• `&&tx tai` (Đặt Tài - Tổng 11 đến 18 điểm)\n• `&&tx xiu` (Đặt Xỉu - Tổng 3 đến 10 điểm)");
        }

        // Kết quả THẬT được chốt ngay từ đầu (đảm bảo công bằng, ko lộ dần).
        // Các khung hình "lắc" bên dưới chỉ là hiệu ứng hiển thị cho kịch tính.
        const d1 = crypto.randomInt(1, 7);
        const d2 = crypto.randomInt(1, 7);
        const d3 = crypto.randomInt(1, 7);
        const sum = d1 + d2 + d3;

        const diceEmojis = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
        const randomDiceStr = () => {
            const r1 = crypto.randomInt(1, 7);
            const r2 = crypto.randomInt(1, 7);
            const r3 = crypto.randomInt(1, 7);
            return `${diceEmojis[r1 - 1]} ${diceEmojis[r2 - 1]} ${diceEmojis[r3 - 1]}`;
        };

        const rollingEmbed = new EmbedBuilder()
            .setTitle('🎲 Đang lắc xúc xắc...')
            .setColor(0xFFFF00)
            .setDescription(`đã chọn: **${choice.toUpperCase()}**\n\nXúc xắc: **${randomDiceStr()}**`)
            .setFooter({ text: 'Đây chỉ là trò chơi giải trí - vxrn bot' });

        const sentMessage = await message.reply({ embeds: [rollingEmbed] });

        const ROLL_STEPS = 6;
        for (let step = 0; step < ROLL_STEPS; step++) {
            await new Promise(res => setTimeout(res, 350 + step * 60)); // càng lắc càng chậm lại -> kịch tính hơn
            rollingEmbed.setDescription(`đã chọn: **${choice.toUpperCase()}**\n\nXúc xắc: **${randomDiceStr()}**`);
            await sentMessage.edit({ embeds: [rollingEmbed] }).catch(() => null);
        }

        const diceStr = `${diceEmojis[d1 - 1]} ${diceEmojis[d2 - 1]} ${diceEmojis[d3 - 1]}`;

        let result = (sum >= 11) ? 'tai' : 'xiu';
        let isWin = (choice === result);

        const embed = new EmbedBuilder()
            .setTitle('Kết quả (Result)')
            .setColor(isWin ? 0x00FF00 : 0xFF0000)
            .setDescription(`đã chọn: **${choice.toUpperCase()}**\n\nXúc xắc: **${diceStr}**\nTổng điểm: **${sum}** -> **${result.toUpperCase()}**`)
            .addFields({
                name: 'Kết quả',
                value: isWin ? '<a:Stelle_Hehe:1536715865180082276> Win!' : '<:huhu:1536597814216495154> uhh you losed! <:huhu:1536597814216495154>'
            })
            .setFooter({ text: 'Đây chỉ là trò chơi giải trí - vxrn bot' })
            .setTimestamp();

        return sentMessage.edit({ embeds: [embed] });
    }

    // ------------------------------------------
    // MINI GAME: &&kbb (KÉO BÚA BAO - lựa chọn ẩn cho tới khi cả 2 đã chọn)
    // ------------------------------------------
    if (message.content.startsWith('&&kbb') || message.content.startsWith('&&keobuabao')) {
        const player1 = message.author;
        const player2 = message.mentions.users.first();

        if (!player2) {
            return message.reply("✂️🪨📄 **Cách chơi Kéo Búa Bao:**\nTag người muốn thách đấu! Ví dụ: `&&kbb @Zeraa`");
        }
        if (player2.id === player1.id) {
            return message.reply("❌ Ko thể tự chơi với chính mình!");
        }
        if (player2.bot) {
            return message.reply("❌ Ko thể thách đấu bot!");
        }

        const choices = {}; // { [userId]: 'keo' | 'bua' | 'bao' }
        const labels = { keo: '✂️ Kéo', bua: '🪨 Búa', bao: '📄 Bao' };
        const beats = { keo: 'bao', bua: 'keo', bao: 'bua' }; // key thắng value

        const buildRow = () => new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('kbb_keo').setLabel('Kéo').setEmoji('✂️').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('kbb_bua').setLabel('Búa').setEmoji('🪨').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('kbb_bao').setLabel('Bao').setEmoji('📄').setStyle(ButtonStyle.Secondary)
        );

        const statusLine = () => `**${player1.username}:** ${choices[player1.id] ? '✅ Đã chọn' : '⏳ Chưa chọn'}\n**${player2.username}:** ${choices[player2.id] ? '✅ Đã chọn' : '⏳ Chưa chọn'}`;

        const waitEmbed = new EmbedBuilder()
            .setTitle('✂️🪨📄 Kéo Búa Bao')
            .setColor(0xFFA500)
            .setDescription(`⚔️ **${player1.username}** thách đấu **${player2.username}**!\n\nCả 2 bấm chọn 1 trong 3 nút bên dưới (lựa chọn được giữ kín cho tới khi cả 2 đã chọn xong).\n\n${statusLine()}`)
            .setFooter({ text: 'Có 60s để chọn - vxrn bot' });

        const gameMsg = await message.reply({ embeds: [waitEmbed], components: [buildRow()] });

        const collector = gameMsg.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 60000
        });

        collector.on('collect', async (i) => {
            if (i.user.id !== player1.id && i.user.id !== player2.id) {
                return i.reply({ content: '❌ Bạn ko phải người chơi trong trận này!', ephemeral: true });
            }
            if (choices[i.user.id]) {
                return i.reply({ content: '⚠️ Bạn đã chọn rồi, đợi đối thủ nha!', ephemeral: true });
            }

            const pick = i.customId.replace('kbb_', '');
            choices[i.user.id] = pick;

            try {
                await i.reply({ content: `Bạn đã chọn ${labels[pick]}! Đợi đối thủ chọn xong...`, ephemeral: true });

                waitEmbed.setDescription(`⚔️ **${player1.username}** thách đấu **${player2.username}**!\n\nCả 2 bấm chọn 1 trong 3 nút bên dưới (lựa chọn được giữ kín cho tới khi cả 2 đã chọn xong).\n\n${statusLine()}`);
                await gameMsg.edit({ embeds: [waitEmbed] }).catch(() => null);

                if (choices[player1.id] && choices[player2.id]) {
                    collector.stop('done');

                    const p1Choice = choices[player1.id];
                    const p2Choice = choices[player2.id];

                    let resultText;
                    if (p1Choice === p2Choice) {
                        resultText = '🤝 **HÒA!**';
                    } else if (beats[p1Choice] === p2Choice) {
                        resultText = `🏆 **${player1.username}** thắng!`;
                    } else {
                        resultText = `🏆 **${player2.username}** thắng!`;
                    }

                    const finalEmbed = new EmbedBuilder()
                        .setTitle('✂️🪨📄 Kết quả Kéo Búa Bao')
                        .setColor(0x00FF00)
                        .setDescription(`**${player1.username}:** ${labels[p1Choice]}\n**${player2.username}:** ${labels[p2Choice]}\n\n${resultText}`)
                        .setFooter({ text: 'Đây chỉ là trò chơi giải trí - vxrn bot' })
                        .setTimestamp();

                    await gameMsg.edit({ embeds: [finalEmbed], components: [] }).catch(() => null);
                }
            } catch (err) {
                console.error("❌ Lỗi khi xử lý lượt Kéo Búa Bao:", err);
            }
        });

        collector.on('end', async (collected, reason) => {
            if (reason === 'time' && !(choices[player1.id] && choices[player2.id])) {
                const timeoutEmbed = new EmbedBuilder()
                    .setTitle('✂️🪨📄 Kéo Búa Bao')
                    .setColor(0x808080)
                    .setDescription('⌛ Hết giờ! Không đủ 2 người chọn nên trận đấu bị huỷ.');
                await gameMsg.edit({ embeds: [timeoutEmbed], components: [] }).catch(() => null);
            }
        });

        return;
    }

    // ------------------------------------------
    // MINI GAME: &&caro (CỜ CARO 3x3 CÓ DM INVITE & 5P TIMEOUT)
    // ------------------------------------------
    if (message.content.startsWith('&&caro')) {
        const opponent = message.mentions.users.first();

        if (!opponent) {
            return message.reply("**Cách chơi Caro (Tic-Tac-Toe):**\nTag tên người muốn thách đấu! Ví dụ: `&&caro @Zeraa`");
        }

        if (opponent.id === message.author.id) {
            return message.reply("<:denia_fcku:1536716087314350150> bro ko thể tự chơi một mình được!");
        }

        if (opponent.bot) {
            return message.reply("<:denia_fcku:1536716087314350150> ko chs đc vs bot đâu bro");
        }

        const player1 = message.author;
        const player2 = opponent;
        let currentTurn = player1;
        let board = Array(9).fill(null);

        const renderBoardComponents = (disabled = false) => {
            const rows = [];
            for (let i = 0; i < 3; i++) {
                const row = new ActionRowBuilder();
                for (let j = 0; j < 3; j++) {
                    const idx = i * 3 + j;
                    const btn = new ButtonBuilder()
                        .setCustomId(`caro_${idx}`)
                        .setDisabled(disabled || board[idx] !== null);

                    if (board[idx] === 'X') {
                        btn.setLabel('❌').setStyle(ButtonStyle.Danger);
                    } else if (board[idx] === 'O') {
                        btn.setLabel('⭕').setStyle(ButtonStyle.Primary);
                    } else {
                        btn.setLabel('\u2800').setStyle(ButtonStyle.Secondary);
                    }
                    row.addComponents(btn);
                }
                rows.push(row);
            }
            return rows;
        };

        const checkWinner = () => {
            const winPatterns = [
                [0, 1, 2], [3, 4, 5], [6, 7, 8],
                [0, 3, 6], [1, 4, 7], [2, 5, 8],
                [0, 4, 8], [2, 4, 6]
            ];
            for (const [a, b, c] of winPatterns) {
                if (board[a] && board[a] === board[b] && board[a] === board[c]) {
                    return board[a];
                }
            }
            if (board.every(cell => cell !== null)) return 'DRAW';
            return null;
        };

        // Gửi tin nhắn chờ tại Channel
        const pendingEmbed = new EmbedBuilder()
            .setTitle('Lời mời thách đấu')
            .setColor(0xFFFF00)
            .setDescription(`<:jakibietbay:1538549949179101228><@${player1.id}> đã gửi lời mời chơi Caro đến <@${player2.id}>.\nĐang chờ <@${player2.id}> xác nhận trong DM`)
            .setTimestamp();

        const gameMsg = await message.reply({ embeds: [pendingEmbed] });

        // Tạo nút Chấp nhận / Từ chối
        const inviteRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('caro_accept')
                .setLabel('Chấp nhận')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('caro_decline')
                .setLabel('Từ chối')
                .setStyle(ButtonStyle.Danger)
        );

        let dmMessage = null;
        let dmFailed = false;

        // Gửi DM cho người được thách đấu
        try {
            dmMessage = await opponent.send({
                content: `Bạn được <@${player1.id}> mời vô ván game **Caro 3x3** tại ${gameMsg.url}, bạn có chấp nhận?`,
                components: [inviteRow]
            });
        } catch (dmErr) {
            dmFailed = true;
            // Nếu bị khóa DM, hiển thị nút bấm trực tiếp tại Channel
            await gameMsg.edit({
                content: `⚠️ Không thể gửi DM cho <@${player2.id}>. Xác nhận trực tiếp tại đây:`,
                embeds: [pendingEmbed],
                components: [inviteRow]
            });
        }

        const inviteTargetMsg = dmFailed ? gameMsg : dmMessage;

        const inviteCollector = inviteTargetMsg.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 300000 // 5 phút chờ trả lời
        });

        inviteCollector.on('collect', async (i) => {
            if (i.user.id !== player2.id) {
                return i.reply({ content: '❌ Bạn không phải là người được mời!', ephemeral: true });
            }

            if (i.customId === 'caro_accept') {
                inviteCollector.stop('accepted');

                try {
                    if (!dmFailed && dmMessage) {
                        await i.update({
                            content: `✅ Bạn đã **chấp nhận** lời mời chơi Caro từ <@${player1.id}>! Ván game đang diễn ra tại ${gameMsg.url}`,
                            components: []
                        });
                    } else {
                        await i.deferUpdate();
                    }

                    // Trước đây gọi không có await/try-catch nên nếu bước này lỗi
                    // (mất quyền edit, rate limit, v.v.) nó sẽ fail âm thầm và
                    // ván game không bao giờ bắt đầu mà không có lỗi nào hiện ra.
                    await startActiveGame();
                } catch (err) {
                    console.error("❌ Lỗi khi bắt đầu trận Caro:", err);
                    await gameMsg.edit({
                        content: `⚠️ Có lỗi khi bắt đầu ván game: \`${err.message}\`. Thử thách đấu lại nhé.`,
                        embeds: [],
                        components: []
                    }).catch(() => null);
                }

            } else if (i.customId === 'caro_decline') {
                inviteCollector.stop('declined');

                if (!dmFailed && dmMessage) {
                    await i.update({
                        content: `❌ Bạn đã **từ chối** lời mời chơi Caro từ <@${player1.id}>.`,
                        components: []
                    }).catch(() => null);
                } else {
                    await i.deferUpdate().catch(() => null);
                }

                const declineEmbed = new EmbedBuilder()
                    .setTitle('Lời mời Caro')
                    .setColor(0xFF0000)
                    .setDescription(`❌ <@${player2.id}> đã từ chối lời mời chơi Caro từ <@${player1.id}>.`)
                    .setTimestamp();

                await gameMsg.edit({ content: null, embeds: [declineEmbed], components: [] });
            }
        });

        inviteCollector.on('end', (collected, reason) => {
            if (reason === 'time') {
                if (!dmFailed && dmMessage) {
                    dmMessage.edit({
                        content: `Lời mời chơi Caro tại ${gameMsg.url} đã hết hạn do không có phản hồi trong 5 phút.`,
                        components: []
                    }).catch(() => null);
                }

                const timeoutEmbed = new EmbedBuilder()
                    .setTitle('Lời mời Caro')
                    .setColor(0x808080)
                    .setDescription(`Lời mời chơi Caro đã bị hủy do <@${player2.id}> không phản hồi trong 5 phút.`)
                    .setTimestamp();

                gameMsg.edit({ content: null, embeds: [timeoutEmbed], components: [] }).catch(() => null);
            }
        });

        // Hàm bắt đầu trận đấu Caro chính thức
        async function startActiveGame() {
            const activeEmbed = new EmbedBuilder()
                .setTitle('Bàn cờ Caro<:jakibietbay:1538549949179101228>')
                .setColor(0x00FFFF)
                .setDescription(`⚔️ **${player1.username}** (❌) VS **${player2.username}** (⭕)\n\n👉 Lượt đi hiện tại: <@${currentTurn.id}> (${currentTurn.id === player1.id ? '❌' : '⭕'})`)
                .setTimestamp();

            await gameMsg.edit({
                content: 'Ván đấu đã bắt đầu',
                embeds: [activeEmbed],
                components: renderBoardComponents()
            });

            // Timer 5 phút không tương tác -> Tự động hủy ván game
            const gameCollector = gameMsg.createMessageComponentCollector({
                componentType: ComponentType.Button,
                time: 300000 // 5 phút không có tương tác
            });

            gameCollector.on('collect', async (interaction) => {
                if (interaction.user.id !== currentTurn.id) {
                    if (interaction.user.id === player1.id || interaction.user.id === player2.id) {
                        return interaction.reply({ content: '❌ chưa đến lượt!', ephemeral: true });
                    } else {
                        return interaction.reply({ content: '❌ who r u son😭', ephemeral: true });
                    }
                }

                // Reset đồng hồ 5 phút mỗi khi đi cờ
                gameCollector.resetTimer({ time: 300000 });

                const index = parseInt(interaction.customId.split('_')[1]);
                board[index] = currentTurn.id === player1.id ? 'X' : 'O';

                const winner = checkWinner();

                if (winner) {
                    gameCollector.stop(winner);
                    let resultDesc = '';
                    if (winner === 'X') {
                        resultDesc = `<:denia_loveu:1536716153978617906> **${player1.username}** đã chiến thắng!`;
                    } else if (winner === 'O') {
                        resultDesc = `<:denia_loveu:1536716153978617906> **${player2.username}** đã chiến thắng!`;
                    } else {
                        resultDesc = `Hòa, không ai thắng cả!`;
                    }

                    const winEmbed = new EmbedBuilder()
                        .setTitle('Kết quả trò chơi')
                        .setColor(winner === 'DRAW' ? 0xFFFF00 : 0x00FF00)
                        .setDescription(`⚔️ **${player1.username}** VS **${player2.username}**\n\n${resultDesc}`)
                        .setTimestamp();

                    await interaction.update({
                        embeds: [winEmbed],
                        components: renderBoardComponents(true)
                    });
                } else {
                    currentTurn = currentTurn.id === player1.id ? player2 : player1;
                    const nextEmbed = new EmbedBuilder()
                        .setTitle('Caro 3x3')
                        .setDescription(`⚔️ **${player1.username}** (❌) VS **${player2.username}** (⭕)\n\n👉 Lượt đi hiện tại: <@${currentTurn.id}> (${currentTurn.id === player1.id ? '❌' : '⭕'})`)
                        .setTimestamp();

                    await interaction.update({
                        embeds: [nextEmbed],
                        components: renderBoardComponents()
                    });
                }
            });

            gameCollector.on('end', (collected, reason) => {
                if (reason === 'time') {
                    const cancelEmbed = new EmbedBuilder()
                        .setTitle('Đã hủy ván!')
                        .setColor(0xFF0000)
                        .setDescription(`⏰ **Ván game đã tự động hủy do không có tương tác trong 5 phút!**`)
                        .setTimestamp();

                    gameMsg.edit({
                        embeds: [cancelEmbed],
                        components: renderBoardComponents(true)
                    }).catch(() => null);
                }
            });
        }

        return;
    }

    // COMMAND: &&mode <deepseek | groq>
    if (message.content.startsWith('&&mode')) {
        const args = message.content.slice('&&mode'.length).trim().split(/\s+/);
        const targetMode = args[0]?.toLowerCase();

        if (!targetMode) {
            return message.reply(`🤖 **Current AI Mode:** \`${currentAiMode.toUpperCase()}\`\nAvailable modes:\n• \`&&mode deepseek\` (DeepSeek-V3)\n• \`&&mode groq\` (Llama 3.3 70B)`);
        }

        if (targetMode === 'deepseek' || targetMode === 'gemini') {
            currentAiMode = 'deepseek';
            return message.reply("✅ Switched AI Mode to **DEEPSEEK** (`deepseek-chat`).");
        } else if (targetMode === 'groq' || targetMode === 'llama') {
            currentAiMode = 'groq';
            return message.reply("✅ Switched AI Mode to **GROQ** (`compound`).");
        } else {
            return message.reply("❌ Invalid mode! Use \`&&mode deepseek\` or \`&&mode groq\`.");
        }
    }

    // COMMAND: &&resetsession
    if (message.content.startsWith('&&resetsession')) {
        if (userSessions.has(message.author.id)) {
            userSessions.delete(message.author.id);
            return message.reply("**Session Reseted**");
        } else {
            return message.reply("bro chx có session nào cả");
        }
    }

    // COMMAND: &&copyemoji
    if (message.content.startsWith('&&copyemoji')) {
        if (!message.member.permissions.has('ManageGuildExpressions') && message.author.id !== ADMIN_ID) {
            return message.reply("❌ You need the `Manage Emojis and Stickers` permission or be Admin to use this command.");
        }

        const args = message.content.slice('&&copyemoji'.length).trim().split(/\s+/);
        const emojiInput = args[0];
        const newName = args[1];

        if (!emojiInput) {
            return message.reply("⚠️ **Usage:** `&&copyemoji <emoji> <new_name>`\nExample: `&&copyemoji <a:catdance:1234567890> cool_cat`");
        }

        const customEmojiRegex = /<a?:(\w+):(\d+)>/;
        const match = emojiInput.match(customEmojiRegex);

        if (!match) {
            return message.reply("❌ Invalid custom emoji! Make sure to send a custom emoji from a server.");
        }

        const isAnimated = emojiInput.startsWith('<a:');
        const originalName = match[1];
        const emojiId = match[2];
        const emojiName = newName || originalName;

        const sanitizedName = emojiName.replace(/[^a-zA-Z0-9_]/g, '_');
        if (sanitizedName.length < 2) {
            return message.reply("❌ Emoji name must be at least 2 characters long.");
        }

        const extension = isAnimated ? 'gif' : 'png';
        const emojiUrl = `https://cdn.discordapp.com/emojis/${emojiId}.${extension}`;

        try {
            await message.channel.sendTyping();
            
            const createdEmoji = await message.guild.emojis.create({
                attachment: emojiUrl,
                name: sanitizedName
            });

            return message.reply(`✅ Successfully added custom emoji: ${createdEmoji} (\`:${createdEmoji.name}:\`)!`);
        } catch (error) {
            console.error("Copy Emoji Error:", error);
            return message.reply(`❌ Failed to add emoji: ${error.message}`);
        }
    }

    // COMMAND: &&copysticker
    if (message.content.startsWith('&&copysticker')) {
        if (!message.member.permissions.has('ManageGuildExpressions') && message.author.id !== ADMIN_ID) {
            return message.reply("❌ You need the `Manage Emojis and Stickers` permission or be Admin to use this command.");
        }

        const args = message.content.slice('&&copysticker'.length).trim().split(/\s+/);
        const requestedName = args.join(' ').trim();

        let targetSticker = null;

        if (message.stickers.size > 0) {
            targetSticker = message.stickers.first();
        } 
        else if (message.reference) {
            const repliedMessage = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
            if (repliedMessage && repliedMessage.stickers.size > 0) {
                targetSticker = repliedMessage.stickers.first();
            }
        }

        if (!targetSticker) {
            return message.reply("⚠️ **How to use:**\n1. **Reply** to a message with a sticker and type: `&&copysticker <new_name>`\n2. Or **Send a sticker** with `&&copysticker <new_name>` as caption.");
        }

        const newName = requestedName || targetSticker.name;

        if (newName.length < 2 || newName.length > 30) {
            return message.reply("❌ Sticker name must be between 2 and 30 characters.");
        }

        try {
            await message.channel.sendTyping();

            const createdSticker = await message.guild.stickers.create({
                file: targetSticker.url,
                name: newName,
                tags: 'sticker'
            });

            return message.reply(`✅ Successfully added custom sticker: **${createdSticker.name}**!`);
        } catch (error) {
            console.error("Copy Sticker Error:", error);
            return message.reply(`❌ Failed to add sticker: ${error.message}`);
        }
    }

    // ------------------------------------------
    // COMMAND: &&vid <tiktok/youtube link> - tải video & gửi thẳng vào channel
    // ------------------------------------------
    if (message.content.startsWith('&&vid')) {
        const link = message.content.slice('&&vid'.length).trim();

        if (!link || !isSupportedVideoLink(link)) {
            return message.reply("⚠️ **Cách dùng:** `&&vid <link TikTok hoặc YouTube>`");
        }

        const statusMsg = await message.reply("<a:Loading:1539183785109622795> Đang lấy thông tin video...");

        try {
            const data = await fetchSoclipMedia(link);
            const best = pickBestMedia(data.medias);

            if (!best || !best.url) {
                return statusMsg.edit("❌ Ko tìm thấy link media nào khả dụng cho video này.");
            }

            await statusMsg.edit(`⬇<a:Loading:1539183785109622795> Đang tải **${data.title || 'video'}** (${best.label || best.ext})...`);

            const { work } = ensureUserSandbox(message.author.id);
            const safeExt = best.ext || 'mp4';
            const localPath = path.join(work, `vid_${Date.now()}.${safeExt}`);

            await downloadToFile(best.url, localPath);

            const stats = fs.statSync(localPath);
            if (stats.size > DISCORD_UPLOAD_LIMIT) {
                fs.unlink(localPath, () => {});
                return statusMsg.edit(
                    `❌ File quá lớn để gửi qua Discord (${(stats.size / 1024 / 1024).toFixed(1)}MB > 10MB giới hạn server).\n` +
                    `Link gốc: ${best.url}`
                );
            }

            const attachment = new AttachmentBuilder(localPath, { name: `video.${safeExt}` });
            const embed = new EmbedBuilder()
                .setTitle(data.title || 'Video')
                .setColor(0x00B2FF)
                .setFooter({ text: `${data.source || 'unknown'} • ${data.author || 'Unknown'}` });

            await message.reply({ embeds: [embed], files: [attachment] });
            await statusMsg.delete().catch(() => {});

            // Dọn file tạm sau khi gửi xong, tránh rác tích luỹ trong sandbox work.
            fs.unlink(localPath, () => {});
        } catch (err) {
            console.error("❌ Lỗi &&vid:", err);
            await statusMsg.edit(`❌ Lỗi khi tải video: \`${err.message}\``);
        }
        return;
    }

    // ------------------------------------------
    // COMMAND: &&play <tiktok/youtube link> - tách mp3, join voice/stage, phát theo queue
    // ------------------------------------------
    if (message.content.startsWith('&&play')) {
        const link = message.content.slice('&&play'.length).trim();

        if (!link || !isSupportedVideoLink(link)) {
            return message.reply("⚠️ **Cách dùng:** `&&play <link TikTok hoặc YouTube>`");
        }

        const voiceChannel = message.member?.voice?.channel;
        if (!voiceChannel) {
            return message.reply("bro phải ở trong một voice channel");
        }

        if (
            voiceChannel.type !== ChannelType.GuildVoice &&
            voiceChannel.type !== ChannelType.GuildStageVoice
        ) {
            return message.reply("❌ Kênh này ko phải voice channel hoặc sân khấu hợp lệ.");
        }

        const botMember = message.guild.members.me || await message.guild.members.fetchMe().catch(() => null);
        const botPerms = voiceChannel.permissionsFor(botMember);

        if (!botPerms?.has(PermissionFlagsBits.Connect)) {
            return message.reply("❌ Bot ko có quyền **Connect** vào kênh này.");
        }
        if (voiceChannel.type === ChannelType.GuildVoice && !botPerms?.has(PermissionFlagsBits.Speak)) {
            return message.reply("❌ Bot ko có quyền **Speak** trong voice channel này.");
        }

        const statusMsg = await message.reply("<a:Loading:1539183785109622795> Đang lấy thông tin video...");

        try {
            const data = await fetchSoclipMedia(link);
            const best = pickBestMedia(data.medias);

            if (!best || !best.url) {
                return statusMsg.edit("❌ Ko tìm thấy link media nào khả dụng cho video này.");
            }

            await statusMsg.edit(`<a:Loading:1539183785109622795> extracting **${data.title || 'video'}**...`);

            const { work } = ensureUserSandbox(message.author.id);
            const rawPath = path.join(work, `play_raw_${Date.now()}.${best.ext || 'mp4'}`);
            const mp3Path = path.join(work, `play_${Date.now()}.mp3`);

            await downloadToFile(best.url, rawPath);
            await convertToMp3(rawPath, mp3Path);
            fs.unlink(rawPath, () => {}); // ko cần file gốc nữa sau khi đã convert

            const guildId = message.guild.id;
            const queue = getOrCreateQueue(guildId, message.channel.id);

            queue.tracks.push({
                title: data.title || 'Untitled',
                author: data.author || 'Unknown',
                filePath: mp3Path,
                requestedBy: message.author.id
            });

            // Join (hoặc tái sử dụng connection có sẵn) voice/stage.
            let connection = getVoiceConnection(guildId);
            if (!connection) {
                connection = joinVoiceChannel({
                    channelId: voiceChannel.id,
                    guildId,
                    adapterCreator: message.guild.voiceAdapterCreator,
                    selfDeaf: true
                });

                await entersState(connection, VoiceConnectionStatus.Ready, 15_000).catch(() => {
                    throw new Error("Ko thể kết nối vào voice channel (timeout).");
                });

                queue.connection = connection;
                queue.player = createAudioPlayer();
                connection.subscribe(queue.player);

                queue.player.on(AudioPlayerStatus.Idle, () => {
                    const finishedTrack = queue.tracks.shift();
                    if (finishedTrack?.filePath) fs.unlink(finishedTrack.filePath, () => {});
                    playNextInQueue(guildId);
                });

                queue.player.on('error', (err) => {
                    console.error("❌ Lỗi audio player:", err);
                    const failedTrack = queue.tracks.shift();
                    if (failedTrack?.filePath) fs.unlink(failedTrack.filePath, () => {});
                    playNextInQueue(guildId);
                });

                connection.on(VoiceConnectionStatus.Disconnected, () => {
                    destroyQueue(guildId);
                });
            } else if (!queue.connection) {
                // Queue vừa được tạo lại (vd sau khi bị xoá) nhưng connection cũ
                // vẫn còn sống -> gắn lại player cho connection đó.
                queue.connection = connection;
                queue.player = createAudioPlayer();
                connection.subscribe(queue.player);
                queue.player.on(AudioPlayerStatus.Idle, () => {
                    const finishedTrack = queue.tracks.shift();
                    if (finishedTrack?.filePath) fs.unlink(finishedTrack.filePath, () => {});
                    playNextInQueue(guildId);
                });
                queue.player.on('error', (err) => {
                    console.error("❌ Lỗi audio player:", err);
                    const failedTrack = queue.tracks.shift();
                    if (failedTrack?.filePath) fs.unlink(failedTrack.filePath, () => {});
                    playNextInQueue(guildId);
                });
            }

            // Nếu là sân khấu và bot đang bị suppress (chỉ là audience), tự
            // request/unmute lên làm speaker - cần quyền Mute Members hoặc
            // đã được mời làm speaker trước đó, nếu ko sẽ fail và báo rõ.
            if (voiceChannel.type === ChannelType.GuildStageVoice) {
                const stageBotMember = await message.guild.members.fetchMe().catch(() => null);
                if (stageBotMember?.voice?.suppress) {
                    try {
                        await stageBotMember.voice.setSuppressed(false);
                    } catch (err) {
                        await statusMsg.edit(
                            "⚠️ Đã join sân khấu nhưng bot đang ở chế độ audience (bị suppress) và ko tự gỡ được. " +
                            "Cần mời bot làm **Speaker** thủ công (bấm 'Invite to Speak' trên bot) rồi thử lại `&&play`."
                        );
                        return;
                    }
                }
            }

            const position = queue.tracks.length;
            if (position === 1 && !queue.playing) {
                playNextInQueue(guildId);
                await statusMsg.edit(`▶️ Đang phát: **${data.title || 'Untitled'}** — ${data.author || 'Unknown'}`);
            } else {
                await statusMsg.edit(`✅ Đã thêm vào hàng đợi (vị trí #${position}): **${data.title || 'Untitled'}** — ${data.author || 'Unknown'}`);
            }
        } catch (err) {
            console.error("❌ Lỗi &&play:", err);
            await statusMsg.edit(`❌ Lỗi khi phát nhạc: \`${err.message}\``);
        }
        return;
    }

    // ------------------------------------------
    // COMMAND: &&skip - bỏ qua bài đang phát
    // ------------------------------------------
    if (message.content.startsWith('&&skip')) {
        const queue = getQueue(message.guild?.id);
        if (!queue || !queue.player || queue.tracks.length === 0) {
            return message.reply("Ko có bài nào đang phát để skip.");
        }
        queue.player.stop(); // trigger AudioPlayerStatus.Idle -> tự chuyển bài kế
        return message.reply("Đã skip bài hiện tại.");
    }

    // ------------------------------------------
    // COMMAND: &&stop - dừng nhạc, xoá queue, rời voice
    // ------------------------------------------
    if (message.content.startsWith('&&stop')) {
        const queue = getQueue(message.guild?.id);
        if (!queue) {
            return message.reply("Bot hiện ko ở trong voice channel nào.");
        }
        destroyQueue(message.guild.id);
        return message.reply("Đã dừng nhạc, xoá hàng đợi và rời voice.");
    }

    // ------------------------------------------
    // COMMAND: &&queue - xem danh sách hàng đợi hiện tại
    // ------------------------------------------
    if (message.content.startsWith('&&queue')) {
        const queue = getQueue(message.guild?.id);
        if (!queue || queue.tracks.length === 0) {
            return message.reply("Hàng đợi đang trống.");
        }
        const list = queue.tracks
            .map((t, i) => `${i === 0 ? '▶️' : `${i}.`} **${t.title}** — ${t.author}`)
            .join('\n')
            .substring(0, 4000);
        const embed = new EmbedBuilder()
            .setTitle('Hàng đợi nhạc')
            .setDescription(list)
            .setColor(0x00B2FF);
        return message.reply({ embeds: [embed] });
    }

    // ------------------------------------------
    // MANUAL MODERATION COMMANDS: &&mute / &&to, &&unmute, &&ban, &&unban, &&kick
    // ------------------------------------------
    if (
        message.content.startsWith('&&mute') ||
        message.content.startsWith('&&to ') || message.content === '&&to' ||
        message.content.startsWith('&&unmute') ||
        message.content.startsWith('&&unban') ||
        message.content.startsWith('&&ban') ||
        message.content.startsWith('&&kick')
    ) {
        if (!message.guild) return message.reply("❌ Lệnh này chỉ dùng được trong server.");

        const args = message.content.trim().split(/\s+/);
        const cmd = args[0].replace('&&', '').toLowerCase();
        const extractId = (raw) => raw ? raw.replace(/[<@!>]/g, '') : null;
        const targetId = extractId(args[1]);

        // ---- &&unban <userID> [lý do] ----
        if (cmd === 'unban') {
            if (!message.member.permissions.has('BanMembers') && message.author.id !== ADMIN_ID) {
                return message.reply("❌ Bạn cần quyền `Ban Members` (hoặc là Admin) để dùng lệnh này.");
            }
            if (!targetId || !/^\d+$/.test(targetId)) {
                return message.reply("⚠️ **Cách dùng:** `&&unban <userID> [lý do]`");
            }
            const reason = args.slice(2).join(' ') || `Yêu cầu bởi ${message.author.username}`;
            try {
                await message.guild.bans.remove(targetId, reason);
                return message.reply(`✅ Đã unban <@${targetId}>.`);
            } catch (err) {
                return message.reply(`❌ Lỗi khi unban: ${err.message}`);
            }
        }

        // Các lệnh còn lại thao tác trên member đang có trong server -> validate target
        const usageExtra = (cmd === 'mute' || cmd === 'to') ? ' <duration>' : '';
        if (!targetId || !/^\d+$/.test(targetId)) {
            return message.reply(`⚠️ **Cách dùng:** \`&&${cmd} @user${usageExtra} [lý do]\``);
        }
        if (targetId === message.author.id) {
            return message.reply("❌ bro trying with yourself =))");
        }
        if (targetId === client.user.id) {
            return message.reply("❌ có cái loz :V");
        }

        const check = await canModerateTarget(message, targetId);

        // ---- &&kick @user [lý do] ----
        if (cmd === 'kick') {
            if (!message.member.permissions.has('KickMembers') && message.author.id !== ADMIN_ID) {
                return message.reply("❌ Bạn cần quyền `Kick Members` (hoặc là Admin) để dùng lệnh này.");
            }
            if (!check.allowed) return message.reply(check.reason);
            if (!check.targetMember) return message.reply("❌ Người này ko có trong server.");
            const reason = args.slice(2).join(' ') || `Yêu cầu bởi ${message.author.username}`;
            try {
                await check.targetMember.kick(reason);
                return message.reply(`✅ Đã kick <@${targetId}>. Lý do: ${reason}`);
            } catch (err) {
                return message.reply(`❌ Lỗi khi kick: ${err.message}`);
            }
        }

        // ---- &&ban @user [lý do] ----
        if (cmd === 'ban') {
            if (!message.member.permissions.has('BanMembers') && message.author.id !== ADMIN_ID) {
                return message.reply("❌ Bạn cần quyền `Ban Members` (hoặc là Admin) để dùng lệnh này.");
            }
            if (!check.allowed) return message.reply(check.reason);
            const reason = args.slice(2).join(' ') || `Yêu cầu bởi ${message.author.username}`;
            try {
                await message.guild.members.ban(targetId, { reason });
                return message.reply(`✅ Đã ban <@${targetId}>. Lý do: ${reason}`);
            } catch (err) {
                return message.reply(`❌ Lỗi khi ban: ${err.message}`);
            }
        }

        // ---- &&unmute @user ----
        if (cmd === 'unmute') {
            if (!message.member.permissions.has('ModerateMembers') && message.author.id !== ADMIN_ID) {
                return message.reply("❌ Bạn cần quyền `Timeout Members` (hoặc là Admin) để dùng lệnh này.");
            }
            if (!check.allowed) return message.reply(check.reason);
            if (!check.targetMember) return message.reply("❌ Người này ko có trong server.");
            const reason = args.slice(2).join(' ') || `Yêu cầu bởi ${message.author.username}`;
            try {
                await check.targetMember.timeout(null, reason);
                return message.reply(`✅ Đã unmute <@${targetId}>.`);
            } catch (err) {
                return message.reply(`❌ Lỗi khi unmute: ${err.message}`);
            }
        }

        // ---- &&mute / &&to @user <duration> [lý do] ----
        if (cmd === 'mute' || cmd === 'to') {
            if (!message.member.permissions.has('ModerateMembers') && message.author.id !== ADMIN_ID) {
                return message.reply("❌ Bạn cần quyền `Timeout Members` (hoặc là Admin) để dùng lệnh này.");
            }
            if (!check.allowed) return message.reply(check.reason);
            if (!check.targetMember) return message.reply("❌ Người này ko có trong server.");

            const durationMs = parseDuration(args[2]);
            if (!durationMs) {
                return message.reply(`⚠️ **Cách dùng:** \`&&${cmd} @user <duration> [lý do]\`\nVí dụ: \`&&${cmd} @Zeraa 10m quậy quá\`, \`&&${cmd} @Zeraa 1h30m\`, \`&&${cmd} @Zeraa 2d\`\n(hỗ trợ s/m/h/d, hoặc chỉ nhập số nguyên = số phút)`);
            }

            const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000; // Discord giới hạn timeout tối đa 28 ngày
            const finalMs = Math.min(durationMs, MAX_TIMEOUT_MS);
            const reason = args.slice(3).join(' ') || `Yêu cầu bởi ${message.author.username}`;

            try {
                await check.targetMember.timeout(finalMs, reason);
                return message.reply(`✅ Đã mute <@${targetId}> trong **${formatDuration(finalMs)}**. Lý do: ${reason}`);
            } catch (err) {
                return message.reply(`❌ Lỗi khi mute: ${err.message}`);
            }
        }

        return;
    }

    // ------------------------------------------
    // GEMMA 4 CHAT AI
    // ------------------------------------------
    // FIX: trước đây dùng message.mentions.has(client.user.id) mặc định tính
    // luôn cả @everyone/@here và mention qua role chứa bot là "mention" ->
    // bot bị trigger nhầm dù ko ai thực sự tag thẳng nó. Truyền
    // { ignoreEveryone: true, ignoreRoles: true } để CHỈ tính mention trực
    // tiếp dạng <@id>/<@!id> là mention thật.
    const isMentioned = message.mentions.has(client.user.id, { ignoreEveryone: true, ignoreRoles: true });

    // FIX: fetch message reference có thể throw (vd tin nhắn gốc đã bị xoá)
    // -> trước đây ko có try/catch nên lỗi này rớt xuống catch tổng phía
    // dưới, khiến cả lượt xử lý bị bỏ ngang mà ko rõ nguyên nhân. Giờ bọc
    // riêng, lỗi fetch chỉ coi như "ko phải reply tới bot" thay vì crash.
    let isReplyToBot = false;
    if (message.reference) {
        const repliedMsg = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
        isReplyToBot = repliedMsg?.author?.id === client.user.id;
    }

    if (!isMentioned && !isReplyToBot) return;

    const botMentionRegex = new RegExp(`<@!?${client.user.id}>`, 'g');
    let cleanContent = message.content.replace(botMentionRegex, '').trim();

    if (!cleanContent) return message.reply("Có j hỏi tao ko m?");

    await message.channel.sendTyping();

    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;
    if (timeSinceLastRequest < 2000) {
        const waitTime = 2000 - timeSinceLastRequest;
        await new Promise(res => setTimeout(res, waitTime));
    }
    lastRequestTime = Date.now();

    const isUserAdmin = message.author.id === ADMIN_ID;

    const codeExecInstructions = isUserAdmin ? `

CODE EXECUTION (chỉ khả dụng với Admin/Zeraa):
- Khi cần tính toán phức tạp, kiểm chứng logic, xử lý file, hoặc test 1 đoạn code Node.js, mày có thể yêu cầu chạy thử bằng cách kẹp code vào giữa 2 dòng đánh dấu, đúng định dạng:
$$code
<code Node.js ở đây, dùng console.log để in kết quả>
$$
- Code chạy trong SANDBOX RIÊNG của user đó (ko chung với ai khác), có 2 biến path được bơm sẵn, LUÔN DÙNG 2 BIẾN NÀY thay vì tự đoán đường dẫn:
  + __SANDBOX_UPLOADED__ = thư mục chứa file user đã upload lên Discord (chỉ ĐỌC được, ko ghi/sửa/xoá được file trong này)
  + __SANDBOX_WORK__ = không gian làm việc, đọc/ghi/sửa/xoá thoải mái trong phạm vi này
  Ví dụ đọc 1 file user vừa upload: fs.readFileSync(__SANDBOX_UPLOADED__ + '/tenfile.js', 'utf8')
  Ví dụ ghi file kết quả: fs.writeFileSync(__SANDBOX_WORK__ + '/ketqua.txt', noiDung)
- require('fs') dùng bình thường trong phạm vi 2 thư mục trên, KO cần API đặc biệt gì khác. Đọc/ghi ở BẤT KỲ path nào khác ngoài 2 thư mục này (kể cả cố tình dùng "../" để thoát ra) sẽ bị chặn ở tầng hệ thống.
- child_process, worker_threads, net/http/https/dns (mọi hình thức network thô), eval, new Function(), require động qua biến đều bị chặn CỨNG, ko cách nào né được - đừng viết code kiểu này vì luôn bị từ chối chạy trước khi kịp thực thi.
- Chỉ được require() các built-in module thường dùng (fs, path, crypto, util, buffer...) và các npm package ĐÃ ĐƯỢC ADMIN DUYỆT từ trước. Nếu cần 1 package chưa có, cứ require() bình thường trong code - hệ thống sẽ tự động gửi đề xuất cho Zeraa duyệt và báo lại cho mày biết là đang chờ duyệt, KO tự bịa cách né tránh việc thiếu package.
- Chỉ dùng khi thực sự cần thiết (tính toán/thuật toán/xử lý file/kiểm tra logic), ko lạm dụng cho câu hỏi thông thường.
- Code có timeout 5s, đừng viết vòng lặp vô hạn hoặc chờ network (network luôn bị chặn nên sẽ tự timeout, đừng cố).
- Server chạy bot RAM rất thấp, mỗi lần chạy code chỉ được cấp ~96MB bộ nhớ. Tránh viết code tạo mảng/object cực lớn hoặc load nguyên file rất to vào RAM cùng lúc - nếu cần xử lý file lớn, đọc/xử lý theo từng phần nhỏ thay vì load hết 1 lần.` : '';

    const botArchitectureInstructions = isUserAdmin ? `

KIẾN TRÚC BOT (để trả lời đúng khi Zeraa hỏi về hệ thống, KO được bịa hướng dẫn generic sai với thực tế bên dưới):
- Bot chạy trên Pterodactyl, thư mục gốc là nơi index.js nằm. Cài package mới cho CHÍNH BOT (khác với package cho code sandbox) là chạy "npm install <tên>" ở thư mục gốc đó (qua Console Pterodactyl), rồi restart bot - KO có cách nào bot tự chạy lệnh này, KO tự nhận là "đã cài" hay hướng dẫn kiểu chung chung nếu ko chắc, hỏi lại hoặc nói rõ đây là việc Zeraa phải tự làm qua Console.
- Cấu trúc thư mục thật:
  + index.js - file chính, chứa toàn bộ lệnh && và logic AI
  + Checksuspicious/ai-thoso.js + filter.js - hệ thống chấm điểm nghi vấn member (câu hỏi dồn dập lúc mới join, ko chat lâu ngày, acc lâu năm ít badge, role Member mà offline...), lưu state ở Checksuspicious/log.json, chỉ DM cảnh báo cho Zeraa xem tay, KO tự ban/kick ai
  + Sandbox/manager.js - quản lý thư mục Sandbox/<userId>/uploaded/ (chỉ đọc) và Sandbox/<userId>/work/ (đọc/ghi) cho từng user
  + Sandbox/whitelist.js - danh sách module được phép require() trong code sandbox, lưu ở Sandbox/whitelist.json
  + Sandbox/ast-check.js - dùng acorn/acorn-walk parse code trước khi chạy, chặn module chưa duyệt/eval/require động
  + Sandbox/executor.js - thực thi code qua Node Permission Model, giới hạn RAM 96MB/lần, timeout 5s
- Lệnh && hiện có: &&tx/&&taixiu (tài xỉu), &&kbb/&&keobuabao (kéo búa bao), &&caro (cờ caro DM invite), &&mode, &&resetsession, &&copyemoji, &&copysticker, &&mute/&&to <duration>, &&unmute, &&ban, &&unban, &&kick, &&approve/&&deny <module> (chỉ DM từ Zeraa, duyệt module cho sandbox).
- Package cho code sandbox ($$code$$) đi qua cơ chế whitelist riêng (Sandbox/whitelist.js), KHÔNG liên quan gì đến việc "npm install" cho bot chính - đừng nhầm 2 việc này khi trả lời.
- Nếu Zeraa hỏi 1 chi tiết kỹ thuật mà mày ko chắc chắn khớp đúng với kiến trúc thật ở trên, nói thẳng "để tao check lại code" thay vì suy diễn hoặc dùng kiến thức chung chung về Node.js/Discord bot để đoán - hướng dẫn generic dễ sai với hệ thống cụ thể này.` : '';

    const systemPrompt = `Mày là trợ lý AI của server Discord này. Ưu tiên trả lời ĐÚNG và CÓ ÍCH trước, giữ phong cách vui sau.

PHONG CÁCH:
- Viết tắt Teen-code tự nhiên: ko (không), bt (biết), bth (bình thường), j (gì), đc (được), st (sao), ms (mới), thk (thằng), ng (người), m (mày), t (tao), v.v, đk (đúng không), bro.
- Giọng văn cọc cạch nhẹ, hài hước, bựa tự nhiên như dân Discord thật. Ko thưa gửi lịch sự kiểu robot.
- Trả lời ngắn gọn, đúng trọng tâm câu hỏi. Chỉ nói dài khi câu hỏi thực sự cần chi tiết (code, kiến thức, hướng dẫn từng bước).

CÁCH SUY NGHĨ (để trả lời thông minh, chính xác hơn):
- Đọc kỹ câu hỏi + lịch sử chat trước đó (nếu có) trước khi trả lời, tránh trả lời lạc đề hoặc lặp lại câu trước.
- Với câu hỏi cần tính toán/logic/code, suy nghĩ từng bước trong đầu trước, kiểm tra lại rồi mới chốt câu trả lời cuối cùng, tránh đoán bừa hoặc trả lời sai chắc nịch.
- Nếu ko chắc hoặc thiếu thông tin, nói thẳng "tao ko chắc" hoặc hỏi lại, thay vì bịa ra thông tin sai (đặc biệt là ID, số liệu, sự kiện).
- Ko tự nhận vơ đã thực hiện hành động gì (vd: đã ban/kick ai) nếu chưa thực sự có lệnh yêu cầu điều đó.
- Dùng đúng ngày giờ Việt Nam được cung cấp trong User Info bên dưới nếu câu hỏi liên quan đến thời gian/ngày tháng, ko tự bịa ngày giờ khác.
${codeExecInstructions}

QUYỀN HẠN & MỆNH LỆNH TRỪNG PHẠT:
1. Tao có quyền Ban, Kick, Mute, Unban, Unmute, nhưng CHỈ NGHE LỆNH từ Admin (Zeraa).
1.1. Không réo tên của admin/Zeraa khi thật sự ko cần thiết đến
2. Khi Zeraa bảo phạt hoặc gỡ phạt ai đó (kể cả khi tag dạng <@ID>):
   - Trả lời ngắn gọn, tự nhiên ("Ok xong, tao cho nó cook rồi nhé", "Mute nó 10p rồi nha").
   - BẮT BUỘC kẹp 1 lệnh ngầm tương ứng ở cuối:
     + Ban: $ban <ID>
     + Kick: $kick <ID>
     + Mute: $mute <ID> <phút>
     + Unban: $unban <ID>
     + Unmute: $unmute <ID>
   - TUYỆT ĐỐI KHÔNG xuất lệnh phạt nhắm vào Admin (Zeraa).
3. Nếu đứa khác (ko phải Zeraa) đòi phạt ai:
   - Troll hoặc chửi nhẹ ("Tuổi j đòi ra lệnh?", "M ko phải owner đâu mà đòi ra lệnh =))").
   - TUYỆT ĐỐI KHÔNG xuất các câu lệnh $ban, $kick, $mute, $unban, $unmute.`;

    const vt = await getVietnamTimeInfo();
    const currentTimeStr = `${vt.hour}:${String(vt.minute).padStart(2, '0')} ngày ${vt.day}/${vt.month}/${vt.year} (${vt.weekday})`;

    const userPrompt = `User Info:
ID: ${message.author.id}
Display Name: ${message.author.displayName || message.author.username}
Account Name: ${message.author.username}
Is Admin (Zeraa): ${isUserAdmin ? "Yes (Owner)" : "No"}
Current Time (Vietnam, UTC+7): ${currentTimeStr}
User Question: ${cleanContent}`;

    let sessionHistory = userSessions.get(message.author.id) || [];

    const messagesPayload = [
        { "role": "system", "content": systemPrompt },
        ...sessionHistory,
        { "role": "user", "content": userPrompt }
    ];

    try {
        let apiUrl = "";
        let apiKey = "";
        let modelName = "";

        if (currentAiMode === 'deepseek') {
            if (!process.env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is missing in .env file!");
            apiUrl = "https://api.deepseek.com/chat/completions";
            apiKey = process.env.DEEPSEEK_API_KEY.trim();
            modelName = "deepseek-chat";
        } else {
            if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is missing in .env file!");
            apiUrl = "https://api.groq.com/openai/v1/chat/completions";
            apiKey = process.env.GROQ_API_KEY.trim();
            modelName = "groq/compound";
        }

        const response = await fetch(apiUrl, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                "model": modelName,
                "stream": true,
                "messages": messagesPayload
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`API Status ${response.status}: ${errText}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let fullText = "";
        let sentMessage = await message.reply("Đang suy nghĩ...");
        let lastUpdate = Date.now();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split("\n").filter(line => line.trim() !== "");

            for (const line of lines) {
                if (line.startsWith("data: ")) {
                    const dataStr = line.replace(/^data: /, "");
                    if (dataStr === "[DONE]") break;
                    
                    try {
                        const parsed = JSON.parse(dataStr);
                        const content = parsed.choices?.[0]?.delta?.content || "";
                        fullText += content;

                        const displayContent = cleanModerationCommands(fullText);

                        if (Date.now() - lastUpdate > 1200 && displayContent.trim() !== "") {
                            await sentMessage.edit(displayContent.substring(0, 2000));
                            lastUpdate = Date.now();
                        }
                    } catch (e) {}
                }
            }
        }

        const finalDisplay = cleanModerationCommands(fullText);
        let codeWasExecuted = false;

        if (message.author.id === ADMIN_ID) {
            const codeMatch = fullText.match(/\$\$code\n([\s\S]*?)\n\$\$/);
            if (codeMatch) {
                codeWasExecuted = true;
                const codeToRun = codeMatch[1];
                try {
                    await message.channel.sendTyping();
                    const result = await executeInSandbox(message.author.id, codeToRun);

                    // Nếu bị chặn vì dùng module chưa duyệt -> tự động thêm vào hàng
                    // chờ đề xuất + DM báo admin để duyệt bằng "&&approve <module>"
                    // (kết hợp cả 2 cách duyệt đã chốt: AI đề xuất, Zeraa duyệt tay).
                    if (!result.ok && result.pendingModules && result.pendingModules.length > 0) {
                        for (const mod of result.pendingModules) {
                            sandboxWhitelist.proposeModule(mod, message.author.id, `AI cần dùng trong 1 đoạn code (yêu cầu bởi <@${message.author.id}>)`);
                        }
                        try {
                            const admin = await client.users.fetch(ADMIN_ID).catch(() => null);
                            if (admin) {
                                await admin.send(
                                    `📦 AI vừa đề xuất module mới cần duyệt: **${result.pendingModules.join(', ')}**\n` +
                                    `Duyệt bằng lệnh: \`&&approve <tên module>\` (gõ trong DM này) cho từng module, hoặc \`&&deny <tên module>\` để từ chối.`
                                );
                            }
                        } catch (dmErr) {
                            console.error("❌ Lỗi DM đề xuất module cho admin:", dmErr);
                        }
                    }

                    const codeEmbed = new EmbedBuilder()
                        .setTitle(result.ok ? '✅ Code Execution' : '❌ Code Execution Bị Chặn/Lỗi')
                        .setColor(result.ok ? 0x00FF00 : 0xFF0000)
                        .addFields(
                            { name: 'Code', value: `\`\`\`js\n${codeToRun.slice(0, 1000)}\n\`\`\`` },
                            { name: 'Output', value: `\`\`\`\n${(result.output || '(empty)').slice(0, 1000)}\n\`\`\`` }
                        )
                        .setFooter({ text: result.ok ? 'Sandbox: đọc/ghi giới hạn trong Sandbox/<userId>/work' : 'Xem lý do bị chặn trong Output ở trên' })
                        .setTimestamp();

                    // QUAN TRỌNG (fix bug cũ "exec thành công mà ko chat output ra"):
                    // gửi thẳng vào channel bằng message.reply thay vì channel.send
                    // trần, để Discord hiển thị rõ ràng đây là reply gắn với tin nhắn
                    // gốc của user, ko bị "trôi" lẫn giữa các tin nhắn khác trong
                    // channel đông người chat. KHÔNG bọc .catch(() => null) ở đây -
                    // nếu gửi lỗi phải biết để sửa, im lặng nuốt lỗi là nguyên nhân
                    // gốc gây ra bug cũ.
                    await message.reply({ embeds: [codeEmbed] });
                } catch (err) {
                    console.error("❌ Lỗi khi chạy code sandbox:", err);
                    await message.reply(`⚠️ Lỗi khi chạy code: \`${err.message}\``);
                }
            }

            if (message.guild) {
                await executeModerationCommands(message, fullText);
            }
        }

        // FIX bug "cứ Done! Xong mất tăm": nguyên nhân là finalDisplay bị rỗng
        // sau khi cleanModerationCommands() strip sạch $ban/$kick/$$code$$...
        // trong khi bot THỰC SỰ đã làm gì đó (đã phạt ai / đã chạy code) chứ
        // ko phải ko có phản hồi. Trước đây gộp chung mọi trường hợp finalDisplay
        // rỗng vào 1 câu "Done!" mù mờ. Giờ tách rõ từng trường hợp cụ thể.
        const moderationCmdRegex = /\$(ban|kick|mute|unban|unmute)\s+(?:<@!?)?\d+>?/i;
        const moderationWasRequested = moderationCmdRegex.test(fullText);

        if (finalDisplay.trim()) {
            sessionHistory.push({ "role": "user", "content": cleanContent });
            sessionHistory.push({ "role": "assistant", "content": finalDisplay });

            if (sessionHistory.length > MAX_HISTORY_MESSAGES) {
                sessionHistory = sessionHistory.slice(sessionHistory.length - MAX_HISTORY_MESSAGES);
            }
            userSessions.set(message.author.id, sessionHistory);

            await sentMessage.edit(finalDisplay.substring(0, 2000));
        } else if (codeWasExecuted && moderationWasRequested) {
            await sentMessage.edit("✅ Đã chạy code và xử lý lệnh phạt, xem kết quả ở tin nhắn reply bên dưới 👇");
        } else if (codeWasExecuted) {
            // Trước đây rơi vào nhánh "Done!" chung chung, khiến người dùng tưởng
            // ko có gì xảy ra dù code đã chạy xong (kết quả nằm ở embed reply riêng
            // phía trên) - giờ nói rõ để tránh hiểu lầm giống bug cũ.
            await sentMessage.edit("✅ Đã chạy code, xem kết quả ở tin nhắn reply bên dưới 👇");
        } else if (moderationWasRequested) {
            // AI chỉ xuất mỗi lệnh ngầm ($ban/$kick/...) mà ko kèm câu trả lời nào
            // -> sau khi strip lệnh thì finalDisplay rỗng, dù bot đã thực sự xử lý.
            await sentMessage.edit("✅ Đã xử lý lệnh phạt.");
        } else if (fullText.trim()) {
            // Có text thô từ AI nhưng lại rỗng sau khi clean (hiếm, thường do lỗi
            // format) -> fallback hiển thị nguyên văn thay vì "Done!" mù mờ.
            await sentMessage.edit(fullText.trim().substring(0, 2000));
        } else {
            // AI thực sự ko trả về gì (API lỗi âm thầm/rỗng) -> nói rõ thay vì "Done!".
            await sentMessage.edit("⚠️ AI không trả về nội dung gì, thử hỏi lại lần nữa xem sao.");
        }

    } catch (error) {
        console.error("AI Error Details:", error.message);
        message.reply(`❌ Err AI: ${error.message}`);
    }
});

// ==========================================
// HELPER FUNCTIONS & ROLE HIERARCHY CHECK
// ==========================================

function cleanModerationCommands(text) {
    return text
        .replace(/\$ban\s+(?:<@!?)?\d+>?/gi, '')
        .replace(/\$kick\s+(?:<@!?)?\d+>?/gi, '')
        .replace(/\$mute\s+(?:<@!?)?\d+>?(?:\s+\d+)?/gi, '')
        .replace(/\$unban\s+(?:<@!?)?\d+>?/gi, '')
        .replace(/\$unmute\s+(?:<@!?)?\d+>?/gi, '')
        .replace(/\$\$code\n[\s\S]*?\n\$\$/gi, '')
        .trim();
}

// ==========================================
// AI CODE EXECUTION - dùng ./Sandbox/executor.js (AST-check + Permission
// Model scoped theo user, cho phép đọc/ghi TRONG phạm vi sandbox của chính
// user đó, khác thiết kế cũ là chặn tuyệt đối mọi fs access). Các require()
// liên quan nằm ở đầu file cùng nhóm import khác.
// ==========================================


async function canModerateTarget(message, targetId) {
    const botMember = message.guild.members.me || await message.guild.members.fetchMe().catch(() => null);
    const targetMember = await message.guild.members.fetch(targetId).catch(() => null);

    if (!botMember) return { allowed: false, reason: "Không kiểm tra được quyền hạn của Bot." };
    if (!targetMember) return { allowed: true, targetMember: null };

    if (targetMember.id === message.guild.ownerId) {
        return { allowed: false, reason: `Bro trying ban owner???!` };
    }

    // FIX: EXEMPT_ROLE_ID ("role miễn phạt") trước đây chặn TẤT CẢ hành động
    // phạt (&&ban/&&kick/&&mute thủ công lẫn AI ra lệnh) với người có role này.
    // Giờ role đó CHỈ miễn trừ riêng cho weekly inactivity purge (ko đạt đủ 40
    // tin nhắn/tuần) - xem checkWeeklyInactivityPurge(). Ban/kick/mute thủ công
    // vì lý do khác (vi phạm nội quy, spam...) vẫn áp dụng bình thường lên họ.

    if (targetMember.roles.highest.position >= botMember.roles.highest.position) {
        return { 
            allowed: false, 
            reason: `⚠️ **Failed...**: Không thể vì role của bot thấp hơn role của người đó!` 
        };
    }

    return { allowed: true, targetMember };
}

// Parse duration dạng "10m", "1h30m", "2d", "45s", hoặc chỉ 1 số nguyên (= số phút)
function parseDuration(str) {
    if (!str) return null;
    if (/^\d+$/.test(str)) return parseInt(str, 10) * 60 * 1000;

    const regex = /(\d+)\s*(d|h|m|s)/gi;
    let match;
    let totalMs = 0;
    let found = false;
    while ((match = regex.exec(str)) !== null) {
        found = true;
        const value = parseInt(match[1], 10);
        const unit = match[2].toLowerCase();
        if (unit === 'd') totalMs += value * 24 * 60 * 60 * 1000;
        else if (unit === 'h') totalMs += value * 60 * 60 * 1000;
        else if (unit === 'm') totalMs += value * 60 * 1000;
        else if (unit === 's') totalMs += value * 1000;
    }
    return found ? totalMs : null;
}

function formatDuration(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const d = Math.floor(totalSeconds / 86400);
    const h = Math.floor((totalSeconds % 86400) / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    const parts = [];
    if (d) parts.push(`${d} ngày`);
    if (h) parts.push(`${h} giờ`);
    if (m) parts.push(`${m} phút`);
    if (s && !d && !h) parts.push(`${s} giây`);
    return parts.join(' ') || '0 phút';
}

async function executeModerationCommands(message, text) {
    const banMatch = text.match(/\$ban\s+(?:<@!?)?(\d+)>?/i);
    const kickMatch = text.match(/\$kick\s+(?:<@!?)?(\d+)>?/i);
    const muteMatch = text.match(/\$mute\s+(?:<@!?)?(\d+)>?(?:\s+(\d+))?/i);
    const unbanMatch = text.match(/\$unban\s+(?:<@!?)?(\d+)>?/i);
    const unmuteMatch = text.match(/\$unmute\s+(?:<@!?)?(\d+)>?/i);

    const actionReason = "Requested by Zeraa";

    const executeAction = async (match, actionType, fn) => {
        if (!match) return;
        const targetId = match[1];

        if (targetId === ADMIN_ID || targetId === message.author.id) {
            console.log(`[SAFETY BLOCK] Prevented ${actionType} on Admin/Author (${targetId})`);
            return message.channel.send("⚠️ Protection: Bot will NOT execute moderation actions on the Admin/Author.");
        }

        const check = await canModerateTarget(message, targetId);
        if (!check.allowed) return message.channel.send(check.reason);

        await fn(targetId, check);
    };

    try {
        if (banMatch) {
            await executeAction(banMatch, "BAN", async (targetId) => {
                await message.guild.members.ban(targetId, { reason: actionReason });
                console.log(`[EXECUTE] Banned User ID: ${targetId}`);
            });
        }

        if (unbanMatch) {
            await executeAction(unbanMatch, "UNBAN", async (targetId) => {
                await message.guild.bans.remove(targetId, actionReason);
                console.log(`[EXECUTE] Unbanned User ID: ${targetId}`);
            });
        }

        if (kickMatch) {
            await executeAction(kickMatch, "KICK", async (targetId) => {
                await message.guild.members.kick(targetId, actionReason);
                console.log(`[EXECUTE] Kicked User ID: ${targetId}`);
            });
        }

        if (muteMatch) {
            await executeAction(muteMatch, "MUTE", async (targetId, check) => {
                const minutes = parseInt(muteMatch[2]) || 10;
                if (check.targetMember) {
                    await check.targetMember.timeout(minutes * 60 * 1000, actionReason);
                    console.log(`[EXECUTE] Muted User ID: ${targetId} trong ${minutes} phút`);
                }
            });
        }

        if (unmuteMatch) {
            await executeAction(unmuteMatch, "UNMUTE", async (targetId, check) => {
                if (check.targetMember) {
                    await check.targetMember.timeout(null, actionReason);
                    console.log(`[EXECUTE] Unmuted User ID: ${targetId}`);
                }
            });
        }

    } catch (err) {
        console.error("❌ Lỗi thực thi lệnh phạt:", err.message);
        message.channel.send(`⚠️ *Failed...: ${err.message}*`);
    }
}

// ==========================================
// INTERACTION HANDLER: /snipe, /anti-snipe
// ==========================================
client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'anti-snipe') {
        if (!interaction.guild) {
            return interaction.reply({ content: "❌ Lệnh này chỉ dùng được trong server.", ephemeral: true });
        }

        const enable = interaction.options.getBoolean('enable', true);
        const cfg = loadAntiSnipeConfig();
        cfg.enabled = enable;
        saveAntiSnipeConfig(cfg);

        return interaction.reply({
            content: enable
                ? "**Anti-snipe enabled**"
                : "**Anti-snipe disabled**",
            ephemeral: true
        });
    }

    if (interaction.commandName === 'snipe') {
        if (!interaction.guild) {
            return interaction.reply({ content: "❌ Lệnh này chỉ dùng được trong server.", ephemeral: true });
        }

        // ANTI-SNIPE: nếu đang bật, chỉ chặn người có role THẤP HƠN bot.
        // Người có role cao hơn/bằng bot (admin/mod cấp cao) vẫn xem được.
        const cfg = loadAntiSnipeConfig();
        if (cfg.enabled) {
            const isAbove = await isAboveBotHierarchy(interaction.guild, interaction.user.id);
            if (!isAbove) {
                return interaction.reply({ content: "Anti-snipe đang bật, bạn ko có quyền xem tin nhắn đã xoá/sửa ở đây.", ephemeral: true });
            }
        }

        const entries = snipeCache.get(interaction.channel.id) || [];
        if (entries.length === 0) {
            return interaction.reply({ content: "Chưa có tin nhắn nào bị xoá/sửa gần đây trong channel này.", ephemeral: true });
        }

        const index = interaction.options.getInteger('index') || 1;
        // index=1 nghĩa là gần nhất -> lấy từ cuối mảng ra
        const entry = entries[entries.length - index];

        if (!entry) {
            return interaction.reply({ content: `❌ Chỉ có ${entries.length} tin nhắn được lưu trong channel này (yêu cầu index ${index}).`, ephemeral: true });
        }

        const embed = new EmbedBuilder()
            .setAuthor({ name: entry.authorTag, iconURL: entry.authorAvatar || undefined })
            .setFooter({ text: `Snipe ${index}/${entries.length} • vxrn bot` })
            .setTimestamp(entry.type === 'delete' ? entry.deletedTimestamp : entry.editedTimestamp);

        if (entry.type === 'delete') {
            embed.setTitle('Message deleted')
                .setColor(0xFF0000)
                .setDescription(entry.content ? entry.content.substring(0, 4000) : '*(không có nội dung text)*');

            if (entry.attachments && entry.attachments.length > 0) {
                // Hiện ảnh đầu tiên trực tiếp trong embed nếu là file ảnh, còn lại liệt kê link
                const firstImg = entry.attachments.find(a => /\.(png|jpe?g|gif|webp)$/i.test(a.name || ''));
                if (firstImg) embed.setImage(firstImg.url);

                embed.addFields({
                    name: `File attached (${entry.attachments.length})`,
                    value: entry.attachments.map(a => `[${a.name}](${a.url})`).join('\n').substring(0, 1024)
                });
            }
        } else {
            embed.setTitle('Message edited')
                .setColor(0xFFA500)
                .addFields(
                    { name: 'After', value: (entry.oldContent || '*(trống)*').substring(0, 1000) },
                    { name: 'Before', value: (entry.newContent || '*(trống)*').substring(0, 1000) }
                );

            if (entry.attachments && entry.attachments.length > 0) {
                embed.addFields({
                    name: `File attached (${entry.attachments.length})`,
                    value: entry.attachments.map(a => `[${a.name}](${a.url})`).join('\n').substring(0, 1024)
                });
            }
        }

        return interaction.reply({ embeds: [embed] });
    }
});

client.login(process.env.DISCORD_TOKEN);