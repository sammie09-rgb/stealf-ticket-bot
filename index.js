// index.js - patched ticket bot (upgraded UI, bug report button, safe thumbnail, capitalized labels)
// Based on your backup + requested safe UI upgrades
require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  Routes,
  REST,
  PermissionsBitField,
  EmbedBuilder,
  ChannelType
} = require('discord.js');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const SUPPORT_ROLE_ID = process.env.SUPPORT_ROLE_ID || null;
const CATEGORY_ID = process.env.CATEGORY_ID || null;
const THUMB_URL_RAW = process.env.THUMB_URL || null;
const FOOTER_ICON_URL = process.env.FOOTER_ICON_URL || null;

console.log("RAILWAY DEBUG — TOKEN:", !!TOKEN, "CLIENT_ID:", !!CLIENT_ID, "GUILD_ID:", !!GUILD_ID);

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('missing env vars. please set TOKEN, CLIENT_ID and GUILD_ID in .env');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

// register the /ticketpanel slash command as guild command (fast iteration)
const commands = [
  new SlashCommandBuilder()
    .setName('ticketpanel')
    .setDescription('Drops the ticket panel with Support, Partnerships and Bug Reports buttons')
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('slash command registered (guild)');
  } catch (err) {
    console.error('failed to register commands', err);
  }
})();

client.once('ready', () => {
  console.log(`bot is online as ${client.user.tag}`);
});

// helper: safe stringify to avoid crashing on BigInt, etc.
function safeStringify(obj, space = 2) {
  return JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), space);
}

// helper: resolve role safely
function resolveRole(guild, id) {
  if (!id) return null;
  return guild.roles.cache.get(id) || guild.roles.resolve(id) || null;
}

// ticket action buttons (Claim / Close / Reopen / Delete)
function ticketActionButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_claim').setLabel('Claim').setStyle(ButtonStyle.Primary).setEmoji('🎟️'),
    new ButtonBuilder().setCustomId('ticket_close').setLabel('Close').setStyle(ButtonStyle.Secondary).setEmoji('🔒'),
    new ButtonBuilder().setCustomId('ticket_reopen').setLabel('Reopen').setStyle(ButtonStyle.Success).setEmoji('🔓'),
    new ButtonBuilder().setCustomId('ticket_delete').setLabel('Delete').setStyle(ButtonStyle.Danger).setEmoji('🗑️')
  );
}

// confirm row (Confirm + Cancel) with dynamic prefix
function confirmButtons(prefix) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${prefix}_confirm`).setLabel('Confirm').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`${prefix}_cancel`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
  );
}

// in-memory pending actions map (channelId -> pending)
const pendingActions = new Map();

// safe thumbnail handling: returns either empty string (no thumb) or a valid http(s) url
function normalizeThumbUrl(raw) {
  if (!raw) return '';
  let v = String(raw).trim();
  // protocol-relative urls like //cdn.domain/xxx
  if (v.startsWith('//')) v = `https:${v}`;
  // only accept http(s) urls
  if (/^https?:\/\//i.test(v)) return v;
  return ''; // otherwise ignore
}

// small helper to capitalize first letter and keep rest
function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

client.on('interactionCreate', async interaction => {
  try {
    // handle slash command -> post panel into channel, but confirm ephemerally
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'ticketpanel') {
        // defer ephemeral so we have time to send the panel publicly and then confirm
        await interaction.deferReply({ ephemeral: true }).catch(() => {});

        // build a sleeker embed (black + silver theme)
        const embed = new EmbedBuilder()
          .setTitle('How can we help?')
          .setDescription(
            "Welcome to the Stealthy Frog's ticketing channel.\n\n" +
            "If you have any questions or technical issues, click **Support** to open a ticket with staff.\n\n" +
            "For partnership inquiries, click **Partnerships**.\n\n" +
            "If you found a platform bug, click **Bug Reports** to file it.\n\n" +
            "Thanks and stay stealthy!"
          )
          // black / silver themed color (dark background with subtle silver)
          .setColor(0x0f0f0f)
          .setFooter({ text: 'stealf support', iconURL: FOOTER_ICON_URL || undefined });

        const thumb = normalizeThumbUrl(THUMB_URL_RAW);
        if (thumb) embed.setThumbnail(thumb);

        // row with three buttons: Support, Partnerships, Bug Reports
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('open_support').setLabel('Support').setEmoji('📩').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('open_partnerships').setLabel('Partnerships').setEmoji('🤝').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('open_bugreports').setLabel('Bug Reports').setEmoji('🐞').setStyle(ButtonStyle.Danger)
        );

        // send public panel into the same channel where the command was used
        try {
          await interaction.channel.send({ embeds: [embed], components: [row] });
        } catch (err) {
          console.error('failed to send panel into channel:', err);
          // tell user ephemeral that posting failed
          await interaction.editReply({ content: 'I could not post the panel in this channel (check bot permissions).' }).catch(() => {});
          return;
        }

        // edit ephemeral reply to confirm success
        await interaction.editReply({ content: 'Ticket panel posted ✅' }).catch(() => {});
      }
      return;
    }

    // other interactions must be buttons for our flow
    if (!interaction.isButton()) return;

    const { customId, guild, user } = interaction;
    if (!guild) return interaction.reply({ content: 'This must be used inside a server.', ephemeral: true });

    // open ticket group (support / partnerships / bugreports)
    if (customId === 'open_support' || customId === 'open_partnerships' || customId === 'open_bugreports') {
      const type = customId === 'open_support' ? 'support' : (customId === 'open_partnerships' ? 'partnership' : 'bug');
      // produce readable channel name and keep within limit
      const cleanName = user.username.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 24) + '-' + Math.floor(Math.random() * 9000 + 1000);
      const channelName = `ticket-${type}-${cleanName}`;

      // prevent duplicates by scanning for same user tickets of same type (best-effort)
      const existing = guild.channels.cache.find(ch => ch.name && ch.name.startsWith(`ticket-${type}-`) && ch.type === ChannelType.GuildText && ch.permissionOverwrites.cache.has(user.id));
      if (existing) {
        return interaction.reply({ content: `You already have a ${capitalize(type)} ticket: ${existing}`, ephemeral: true });
      }

      // resolve category if configured
      let category = null;
      let categoryDeniesEveryone = false;
      if (CATEGORY_ID) {
        const c = guild.channels.cache.get(CATEGORY_ID);
        if (c && c.type === ChannelType.GuildCategory) {
          category = c;
          const ew = c.permissionOverwrites.cache.get(guild.roles.everyone.id);
          if (ew && ew.deny?.has(PermissionsBitField.Flags.ViewChannel)) categoryDeniesEveryone = true;
        } else {
          category = null;
        }
      }

      const overwrites = [];
      if (!categoryDeniesEveryone) {
        overwrites.push({ id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] });
      }

      overwrites.push({
        id: user.id,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory]
      });

      // add support role if provided and resolvable
      let supportRole = null;
      if (SUPPORT_ROLE_ID) {
        supportRole = resolveRole(guild, SUPPORT_ROLE_ID);
        if (supportRole) {
          overwrites.push({
            id: supportRole.id,
            allow: [
              PermissionsBitField.Flags.ViewChannel,
              PermissionsBitField.Flags.SendMessages,
              PermissionsBitField.Flags.ManageMessages,
              PermissionsBitField.Flags.ReadMessageHistory
            ]
          });
        } else {
          console.warn('support role id provided but could not resolve role in guild');
        }
      }

      // ensure the bot itself has explicit allow
      const botMember = guild.members.cache.get(client.user.id) || await guild.members.fetch(client.user.id).catch(() => null);
      if (botMember) {
        overwrites.push({
          id: botMember.id,
          allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ReadMessageHistory]
        });
      }

      const createOptions = {
        name: channelName,
        type: ChannelType.GuildText,
        permissionOverwrites: overwrites
      };
      if (category) createOptions.parent = category.id;

      // debug summary
      console.log('--- DEBUG: creating ticket ---');
      console.log('guild id:', guild.id, 'user id:', user.id, 'type:', type);
      console.log('planned overwrites (ids):', overwrites.map(o => ({ id: o.id, allow: o.allow ? o.allow.map(x => x.toString()) : null, deny: o.deny ? o.deny.map(x => x.toString()) : null })));
      console.log('createOptions parent:', createOptions.parent ? createOptions.parent : '(root)');
      console.log('createOptions (safe):', safeStringify(createOptions));

      let channel;
      try {
        channel = await guild.channels.create(createOptions);
      } catch (err) {
        console.error('channel creation failed:', err);
        return interaction.reply({ content: 'I could not create the ticket channel. Make sure the bot has Manage Channels and its role is high enough.', ephemeral: true });
      }

      // check bot perms in the created channel
      if (botMember) {
        const botPerms = channel.permissionsFor(botMember);
        if (!botPerms || !botPerms.has(PermissionsBitField.Flags.SendMessages)) {
          console.warn('bot missing send perms in channel after create; perms:', botPerms ? botPerms.toArray() : botPerms);
          try {
            await interaction.followUp({ content: 'Ticket created but I lack some permissions in the new channel (check channel overrides).', ephemeral: true });
          } catch {}
        }
      }

      await interaction.reply({ content: `Ticket created: ${channel}`, ephemeral: true });

      // send welcome panel into the ticket
      const welcomeMap = {
        support: `Hello <@${user.id}>, a member of Support will be with you shortly. Please explain your issue and attach relevant info.`,
        partnership: `Hello <@${user.id}>, thanks for your interest in Partnerships. Please briefly describe your proposal and any links.`,
        bug: `Hello <@${user.id}>, please give a concise summary of the bug, steps to reproduce, and attach screenshots if possible.`
      };
      const welcome = welcomeMap[type] || welcomeMap.support;

      const panelEmbed = new EmbedBuilder()
        .setTitle(`${capitalize(type)} Ticket`)
        .setDescription(welcome)
        .setColor(type === 'support' ? 0x111111 : (type === 'partnership' ? 0x1f1f1f : 0x111111));

      const thumb2 = normalizeThumbUrl(THUMB_URL_RAW);
      if (thumb2) panelEmbed.setThumbnail(thumb2);

      const actionRow = ticketActionButtons();
      await channel.send({ content: `<@${user.id}>`, embeds: [panelEmbed], components: [actionRow] }).catch(() => {});

      return;
    }

    // ticket action handling (ticket_claim, ticket_close, ticket_reopen, ticket_delete)
    if (customId.startsWith('ticket_')) {
      const [, action] = customId.split('_');
      const channel = interaction.channel;
      const member = interaction.member;
      const guild = interaction.guild;

      if (!channel || !channel.name || !channel.name.startsWith('ticket-')) {
        return interaction.reply({ content: 'This only works inside a ticket channel.', ephemeral: true });
      }

      // Claim
      if (action === 'claim') {
        let mention = `<@${member.id}>`;
        const resolvedSupport = resolveRole(guild, SUPPORT_ROLE_ID);
        if (resolvedSupport) mention = `<@&${resolvedSupport.id}>`;

        await interaction.reply({ content: `Claimed by ${mention}`, ephemeral: true }).catch(() => {});
        await channel.send({ content: `:white_check_mark: ${member.user.tag} claimed this ticket.` }).catch(() => {});
        return;
      }

      // Close -> post confirmation in-channel
      if (action === 'close') {
        const supportRole = resolveRole(guild, SUPPORT_ROLE_ID);
        const isSupport = supportRole ? member.roles.cache.has(supportRole.id) || member.permissions.has(PermissionsBitField.Flags.Administrator) : member.permissions.has(PermissionsBitField.Flags.Administrator);

        // try to infer owner from recent messages
        let ownerId = null;
        try {
          const fetchMessages = await channel.messages.fetch({ limit: 20 });
          for (const [, msg] of fetchMessages) {
            if (!ownerId && msg.mentions && msg.mentions.users.size > 0) {
              ownerId = msg.mentions.users.first().id;
              break;
            }
          }
        } catch (e) {
          // ignore
        }
        const isOwner = ownerId ? ownerId === member.user.id : false;

        if (!(isSupport || isOwner || member.permissions.has(PermissionsBitField.Flags.Administrator))) {
          return interaction.reply({ content: 'Only the ticket owner or support can request to close this ticket', ephemeral: true });
        }

        try {
          const confirmMsg = await channel.send({
            content: `Close requested by <@${member.id}> — click Confirm to lock this ticket.`,
            components: [confirmButtons('close')]
          });
          pendingActions.set(channel.id, { type: 'close', msgId: confirmMsg.id, requestedBy: member.id });
          await interaction.reply({ content: 'Confirm message posted in channel', ephemeral: true }).catch(() => {});
        } catch (err) {
          console.error('failed to post close confirmation in channel:', err);
          return interaction.reply({ content: 'Could not post confirmation message in channel (check permissions).', ephemeral: true });
        }
        return;
      }

      // Reopen
      if (action === 'reopen') {
        await interaction.reply({ content: 'Reopening ticket...', ephemeral: true }).catch(() => {});
        try {
          const msgs = await channel.messages.fetch({ limit: 50 });
          let owner = null;
          for (const [, m] of msgs) {
            if (m.mentions && m.mentions.users.size > 0) {
              owner = m.mentions.users.first();
              break;
            }
          }
          if (owner) {
            await channel.permissionOverwrites.edit(owner.id, { SendMessages: true, ViewChannel: true }).catch(() => {});
            await channel.send(':unlock: Ticket reopened, user can send messages again.').catch(() => {});
          } else {
            await channel.send(':warning: Could not identify ticket owner to restore perms; please adjust manually.').catch(() => {});
          }
        } catch (err) {
          console.error('reopen error', err);
          await interaction.followUp({ content: 'Error while trying to reopen, check logs.', ephemeral: true }).catch(() => {});
        }
        return;
      }

      // Delete -> confirm in-channel
      if (action === 'delete') {
        const supportRole = resolveRole(guild, SUPPORT_ROLE_ID);
        const isSupport = supportRole ? member.roles.cache.has(supportRole.id) || member.permissions.has(PermissionsBitField.Flags.Administrator) : member.permissions.has(PermissionsBitField.Flags.Administrator);
        if (!isSupport) return interaction.reply({ content: 'Only support can delete tickets', ephemeral: true });

        await interaction.reply({ content: 'Confirm message posted in channel', ephemeral: true }).catch(() => {});
        try {
          const confirmMsg = await channel.send({
            content: `Delete requested by <@${member.id}> — click Confirm to permanently delete this ticket.`,
            components: [confirmButtons('delete')]
          });
          pendingActions.set(channel.id, { type: 'delete', msgId: confirmMsg.id, requestedBy: member.id });
        } catch (err) {
          console.error('failed to post delete confirmation', err);
          return interaction.followUp({ content: 'Could not post confirmation message in channel (check permissions).', ephemeral: true });
        }
        return;
      }
    }

    // confirm/cancel handlers (prefix_confirm / prefix_cancel)
    if (customId.endsWith('_confirm') || customId.endsWith('_cancel')) {
      const [prefix, what] = customId.split('_');
      const channel = interaction.channel;
      const guild = interaction.guild;
      const member = interaction.member;

      const pending = pendingActions.get(channel.id);
      if (!pending || pending.type !== prefix) {
        try { await interaction.reply({ content: 'No pending action found for this channel (or it expired).', ephemeral: true }); } catch {}
        return;
      }

      // CANCEL
      if (what === 'cancel') {
        pendingActions.delete(channel.id);
        try {
          if (interaction.message && interaction.message.id === pending.msgId) {
            await interaction.update({ content: 'Action cancelled.', components: [], embeds: [] }).catch(() => {});
          } else {
            const msg = await channel.messages.fetch(pending.msgId).catch(() => null);
            if (msg) await msg.delete().catch(() => {});
            await interaction.reply({ content: 'Action cancelled.', ephemeral: true }).catch(() => {});
          }
        } catch (err) {
          console.error('cancel handler error', err);
        }
        return;
      }

      // CONFIRM
      if (what === 'confirm') {
        // CLOSE confirm
        if (prefix === 'close') {
          const supportRole = resolveRole(guild, SUPPORT_ROLE_ID);
          const isSupport = supportRole ? member.roles.cache.has(supportRole.id) || member.permissions.has(PermissionsBitField.Flags.Administrator) : member.permissions.has(PermissionsBitField.Flags.Administrator);
          const allowedToConfirm = isSupport || member.permissions.has(PermissionsBitField.Flags.Administrator) || (pending.requestedBy === member.id);

          if (!allowedToConfirm) {
            return interaction.reply({ content: 'Only support, the original requester, or an admin can confirm this action.', ephemeral: true });
          }

          try {
            let ownerId = pending.requestedBy || null;
            if (!ownerId) {
              const msgs = await channel.messages.fetch({ limit: 50 });
              for (const [, m] of msgs) {
                if (m.mentions && m.mentions.users.size > 0) {
                  ownerId = m.mentions.users.first().id;
                  break;
                }
              }
            }

            if (ownerId) {
              await channel.permissionOverwrites.edit(ownerId, { SendMessages: false, ViewChannel: true }).catch(() => {});
            } else {
              await channel.permissionOverwrites.edit(guild.roles.everyone.id, { SendMessages: false, ViewChannel: true }).catch(() => {});
            }

            if (supportRole) {
              await channel.permissionOverwrites.edit(supportRole.id, { ViewChannel: true, SendMessages: true }).catch(() => {});
            }
            await channel.permissionOverwrites.edit(client.user.id, { ViewChannel: true, SendMessages: true, ManageChannels: true, ManageMessages: true }).catch(() => {});

            pendingActions.delete(channel.id);

            try {
              if (interaction.message && interaction.message.id === pending.msgId) {
                await interaction.update({ content: ':lock: Ticket closed (confirmed).', components: [], embeds: [] }).catch(() => {});
              } else {
                await interaction.reply({ content: ':lock: Ticket closed (confirmed).', ephemeral: true }).catch(() => {});
              }
            } catch {}
            await channel.send(':lock: This ticket has been closed. Use Reopen to allow the user to send messages again.').catch(() => {});
          } catch (err) {
            console.error('error closing ticket:', err);
            try { await interaction.reply({ content: 'Could not close the ticket, check bot permissions.', ephemeral: true }); } catch {}
          }
          return;
        }

        // DELETE confirm
        if (prefix === 'delete') {
          // only support can delete
          const supportRole = resolveRole(guild, SUPPORT_ROLE_ID);
          const isSupport = supportRole ? member.roles.cache.has(supportRole.id) || member.permissions.has(PermissionsBitField.Flags.Administrator) : member.permissions.has(PermissionsBitField.Flags.Administrator);
          if (!isSupport) return interaction.reply({ content: 'Only support can confirm delete', ephemeral: true });

          try {
            pendingActions.delete(channel.id);
            // remove the confirm message if present
            if (interaction.message && interaction.message.id === pending.msgId) {
              await interaction.update({ content: ':wastebasket: Ticket will be deleted shortly...', components: [], embeds: [] }).catch(() => {});
            } else {
              const msg = await channel.messages.fetch(pending.msgId).catch(() => null);
              if (msg) await msg.delete().catch(() => {});
            }
            // small delay so messages send are seen
            setTimeout(async () => {
              try {
                await channel.send(':wastebasket: Deleting ticket...').catch(() => {});
                await channel.delete('ticket deleted by support').catch((err) => {
                  console.error('failed to delete channel:', err);
                });
              } catch (err) {
                console.error('error during ticket deletion:', err);
              }
            }, 1500);
          } catch (err) {
            console.error('delete confirm error', err);
            try { await interaction.reply({ content: 'Could not delete the ticket, check logs.', ephemeral: true }); } catch {}
          }
          return;
        }
      }
    }

  } catch (err) {
    console.error('interaction handler error', err);
    // try to notify user briefly (ephemeral)
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: 'There was an error, check the logs.', ephemeral: true }).catch(() => {});
      } else {
        await interaction.reply({ content: 'There was an error, check the logs.', ephemeral: true }).catch(() => {});
      }
    } catch (e) {
      console.error('failed to notify user about error', e);
    }
  }
});

client.on('error', (err) => {
  console.error('client error', err);
});
client.on('shardError', (err) => {
  console.error('shard error', err);
});

client.login(TOKEN).catch(err => {
  console.error('failed to login', err);
});
