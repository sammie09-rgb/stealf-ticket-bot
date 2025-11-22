console.log("RAILWAY DEBUG — TOKEN:", !!process.env.TOKEN, "CLIENT_ID:", !!process.env.CLIENT_ID, "GUILD_ID:", !!process.env.GUILD_ID);
// index.js - patched ticket bot (base: version B, patched close flow + safe debug)
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
const SUPPORT_ROLE_ID = process.env.SUPPORT_ROLE_ID || null; // optional
const CATEGORY_ID = process.env.CATEGORY_ID || null; // optional
const THUMB_URL = process.env.THUMB_URL || null;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('missing env vars. please set TOKEN, CLIENT_ID and GUILD_ID in .env');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

const commands = [
  new SlashCommandBuilder()
    .setName('ticketpanel')
    .setDescription('drops the ticket panel with support and partnerships buttons')
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

// small helper to avoid JSON.stringify crashing on BigInt flags in debug output
function safeStringify(obj, space = 2) {
  return JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), space);
}

// helper to check if a role is resolvable in the guild
function resolveRole(guild, id) {
  if (!id) return null;
  return guild.roles.cache.get(id) || guild.roles.resolve(id) || null;
}

// ticket action buttons
function ticketActionButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_claim').setLabel('Claim').setStyle(ButtonStyle.Primary).setEmoji('🎟️'),
    new ButtonBuilder().setCustomId('ticket_close').setLabel('Close').setStyle(ButtonStyle.Secondary).setEmoji('🔒'),
    new ButtonBuilder().setCustomId('ticket_reopen').setLabel('Reopen').setStyle(ButtonStyle.Success).setEmoji('🔓'),
    new ButtonBuilder().setCustomId('ticket_delete').setLabel('Delete').setStyle(ButtonStyle.Danger).setEmoji('🗑️')
  );
}

// confirm (confirm + cancel)
function confirmButtons(prefix) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${prefix}_confirm`).setLabel('Confirm').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`${prefix}_cancel`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
  );
}

// in-memory map for pending confirmations per-channel (non-persistent, minimal change)
const pendingActions = new Map();

/*
  NOTES ABOUT THE CLOSE FLOW CHANGE:
  - previously the bot asked for close confirm via an ephemeral reply.
  - ephemeral component flows can cause "interaction failed" for the confirming user (because components on ephemeral messages behave differently).
  - new behavior: when someone requests a close, the bot posts a confirmation message in the ticket channel (like delete flow).
  - that message contains confirm/cancel buttons (close_confirm / close_cancel).
  - clicking confirm actually performs the close (and the bot replies/updates safely).
  - this mirrors the delete flow and avoids ephemeral-update pitfalls.
*/

client.on('interactionCreate', async interaction => {
  try {
    // slash command -> send panel
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'ticketpanel') {
        const embed = new EmbedBuilder()
          .setTitle('how can we help?')
          .setDescription(
            "welcome to the stealthy frog’s ticketing channel. if you have any questions or technical issues, click **Open Ticket** to contact a member of the stealf team.\n\n" +
            "if you are here for partnership inquiries, click **Partnerships**.\n\n" +
            "thanks and stay stealthy!"
          )
          .setColor(0x5b6eae);

        if (THUMB_URL) embed.setThumbnail(THUMB_URL);

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('open_support').setLabel('open ticket').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('open_partnerships').setLabel('partnership').setStyle(ButtonStyle.Success)
        );

        await interaction.reply({ embeds: [embed], components: [row] });
      }
      return;
    }

    // buttons handling
    if (!interaction.isButton()) return;

    const { customId, guild, user } = interaction;
    if (!guild) return interaction.reply({ content: 'this must be used inside a server.', ephemeral: true });

    // open ticket buttons
    if (customId === 'open_support' || customId === 'open_partnerships') {
      const type = customId === 'open_support' ? 'support' : 'partnerships';
      const cleanName = user.username.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 32);
      const channelName = `ticket-${type}-${cleanName}`;

      // prevent duplicates
      const existing = guild.channels.cache.find(ch => ch.name === channelName && ch.type === ChannelType.GuildText);
      if (existing) {
        return interaction.reply({ content: `you already have a ${type} ticket: ${existing}`, ephemeral: true });
      }

      // build overwrites
      // we will be careful: only add everyone deny if category doesn't already deny it
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

      // support role
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

      // ensure bot has explicit allow to avoid deny collisions
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

      // debug output - use safeStringify to avoid BigInt crash
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
        return interaction.reply({ content: 'i could not create the ticket channel. make sure the bot has Manage Channels and its role is higher than the role it needs to set permissions for.', ephemeral: true });
      }

      // after creation: double-check bot's effective permissions in the created channel
      if (botMember) {
        const botPerms = channel.permissionsFor(botMember);
        if (!botPerms || !botPerms.has(PermissionsBitField.Flags.SendMessages)) {
          console.warn('bot missing send perms in channel after create; perms:', botPerms ? botPerms.toArray() : botPerms);
          try {
            await interaction.followUp({ content: 'ticket created but i lack some permissions in the new channel (check channel overrides).', ephemeral: true });
          } catch {}
        }
      }

      await interaction.reply({ content: `ticket created: ${channel}`, ephemeral: true });

      // send welcome + action buttons
      const welcome = {
        support: `hello <@${user.id}>, a member of support will be with you shortly. explain your issue and attach relevant info.`,
        partnerships: `hello <@${user.id}>, thanks for your interest in partnerships. please briefly describe your proposal and any links.`
      }[type];

      const panelEmbed = new EmbedBuilder()
        .setTitle(`${type.toUpperCase()} ticket`)
        .setDescription(welcome)
        .setColor(type === 'support' ? 0x3b82f6 : 0x10b981);

      if (THUMB_URL) panelEmbed.setThumbnail(THUMB_URL);

      const actionRow = ticketActionButtons();
      await channel.send({ content: `<@${user.id}>`, embeds: [panelEmbed], components: [actionRow] });
      return;
    }

    // handle ticket action buttons (ticket_claim, ticket_close, ticket_reopen, ticket_delete)
    if (customId.startsWith('ticket_')) {
      const [, action] = customId.split('_'); // e.g. ['ticket','close']
      const channel = interaction.channel;
      const member = interaction.member;
      const guild = interaction.guild;

      if (!channel || !channel.name || !channel.name.startsWith('ticket-')) {
        return interaction.reply({ content: 'this only works inside a ticket channel.', ephemeral: true });
      }

      // Claim
      if (action === 'claim') {
        let mention = `<@${member.id}>`;
        const resolvedSupport = resolveRole(guild, SUPPORT_ROLE_ID);
        if (resolvedSupport) mention = `<@&${resolvedSupport.id}>`;

        await interaction.reply({ content: `claimed by ${mention}`, ephemeral: true });
        await channel.send({ content: `:white_check_mark: ${member.user.tag} claimed this ticket.` });
        return;
      }

      // Close -> post confirmation in-channel (so the confirm/cancel components live in the channel)
      if (action === 'close') {
        // find owner/support rights:
        const supportRole = resolveRole(guild, SUPPORT_ROLE_ID);
        const isSupport = supportRole ? member.roles.cache.has(supportRole.id) || member.permissions.has(PermissionsBitField.Flags.Administrator) : member.permissions.has(PermissionsBitField.Flags.Administrator);

        // find possible owner id from first pinned/last message or channel topic - best-effort fallback
        // we will try to infer owner by looking at the first message mentions or the channel name
        let ownerId = null;
        // try to parse owner from channel name (ticket-type-username) -> impossible to reliably map username -> id
        // so we will prefer checking channel's last messages for an author that looks like the opener mention
        try {
          const fetchMessages = await channel.messages.fetch({ limit: 20 });
          // look for first mention of a user id in content, or the first message that mentions a user
          for (const [, msg] of fetchMessages) {
            if (!ownerId && msg.mentions && msg.mentions.users.size > 0) {
              ownerId = msg.mentions.users.first().id;
              break;
            }
          }
        } catch (e) {
          // ignore fetch errors
        }

        const isOwner = ownerId ? ownerId === member.user.id : false;

        // only allow close if support or owner
        if (!(isSupport || isOwner || member.permissions.has(PermissionsBitField.Flags.Administrator))) {
          return interaction.reply({ content: 'only the ticket owner or support can request to close this ticket', ephemeral: true });
        }

        // post confirmation message in channel (non-ephemeral) with close_confirm + close_cancel
        try {
          const confirmMsg = await channel.send({
            content: `Close requested by <@${member.id}> — click Confirm to lock this ticket.`,
            components: [confirmButtons('close')]
          });
          // store pending action so confirm handler knows what to do
          pendingActions.set(channel.id, { type: 'close', msgId: confirmMsg.id, requestedBy: member.id });
          await interaction.reply({ content: 'confirm message posted in channel', ephemeral: true });
        } catch (err) {
          console.error('failed to post close confirmation in channel:', err);
          return interaction.reply({ content: 'could not post confirmation message in channel (check permissions).', ephemeral: true });
        }
        return;
      }

      // Reopen (restore user's send perms)
      if (action === 'reopen') {
        await interaction.reply({ content: 'reopening ticket...', ephemeral: true });
        // best-effort: try to restore send perms for a single user if we can find them from the messages/mentions
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
            await channel.send(':unlock: ticket reopened, user can send messages again.');
          } else {
            await channel.send(':warning: could not identify ticket owner to restore perms; please adjust manually.');
          }
        } catch (err) {
          console.error('reopen error', err);
          await interaction.followUp({ content: 'error while trying to reopen, check logs.', ephemeral: true });
        }
        return;
      }

      // Delete -> post confirmation in-channel (existing pattern)
      if (action === 'delete') {
        // only support
        const supportRole = resolveRole(guild, SUPPORT_ROLE_ID);
        const isSupport = supportRole ? member.roles.cache.has(supportRole.id) || member.permissions.has(PermissionsBitField.Flags.Administrator) : member.permissions.has(PermissionsBitField.Flags.Administrator);
        if (!isSupport) return interaction.reply({ content: 'only support can delete tickets', ephemeral: true });

        await interaction.reply({ content: 'confirm message posted in channel', ephemeral: true }).catch(() => {});
        try {
          const confirmMsg = await channel.send({
            content: `Delete requested by <@${member.id}> — click Confirm Delete to permanently delete this ticket.`,
            components: [confirmButtons('delete')]
          });
          pendingActions.set(channel.id, { type: 'delete', msgId: confirmMsg.id, requestedBy: member.id });
        } catch (err) {
          console.error('failed to post delete confirmation', err);
          return interaction.followUp({ content: 'could not post confirmation message in channel (check permissions).', ephemeral: true });
        }
        return;
      }
    }

    // confirm / cancel handlers (close_confirm, close_cancel, delete_confirm, delete_cancel)
    if (customId.endsWith('_confirm') || customId.endsWith('_cancel')) {
      const [prefix, what] = customId.split('_'); // e.g. ['close','confirm'] OR ['delete','confirm']
      const channel = interaction.channel;
      const guild = interaction.guild;
      const member = interaction.member;

      // find pending action
      const pending = pendingActions.get(channel.id);
      if (!pending || pending.type !== prefix) {
        // nothing pending or mismatch
        // try to gracefully respond
        try {
          await interaction.reply({ content: 'no pending action found for this channel (or it expired).', ephemeral: true });
        } catch {}
        return;
      }

      // CANCEL
      if (what === 'cancel') {
        pendingActions.delete(channel.id);
        // attempt to remove the confirmation message if we can
        try {
          if (interaction.message && interaction.message.id === pending.msgId) {
            await interaction.update({ content: 'action cancelled.', components: [], embeds: [] }).catch(() => {});
          } else {
            // try to fetch and delete the confirm message in channel
            const msg = await channel.messages.fetch(pending.msgId).catch(() => null);
            if (msg) await msg.delete().catch(() => {});
            await interaction.reply({ content: 'action cancelled.', ephemeral: true }).catch(() => {});
          }
        } catch (err) {
          console.error('cancel handler error', err);
        }
        return;
      }

      // CONFIRM
      if (what === 'confirm') {
        // CLOSE CONFIRM
        if (prefix === 'close') {
          // check that requester is allowed to confirm (support or the original requester or admin)
          const supportRole = resolveRole(guild, SUPPORT_ROLE_ID);
          const isSupport = supportRole ? member.roles.cache.has(supportRole.id) || member.permissions.has(PermissionsBitField.Flags.Administrator) : member.permissions.has(PermissionsBitField.Flags.Administrator);
          const allowedToConfirm = isSupport || member.permissions.has(PermissionsBitField.Flags.Administrator) || (pending.requestedBy === member.id);

          if (!allowedToConfirm) {
            return interaction.reply({ content: 'only support, the original requester, or an admin can confirm this action.', ephemeral: true });
          }

          // perform close: deny SendMessages for the ticket owner if we can find them (best-effort)
          try {
            // attempt to identify owner from pending.requestedBy or message history
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

            // if ownerId known, deny send to owner specifically. else fallback: deny send to @everyone and allow view for support & bot
            if (ownerId) {
              await channel.permissionOverwrites.edit(ownerId, { SendMessages: false, ViewChannel: true }).catch(() => {});
            } else {
              // fallback: lock channel from sending for everyone (maintain view for support)
              await channel.permissionOverwrites.edit(guild.roles.everyone.id, { SendMessages: false, ViewChannel: true }).catch(() => {});
            }

            // ensure support role and bot still have access
            if (supportRole) {
              await channel.permissionOverwrites.edit(supportRole.id, { ViewChannel: true, SendMessages: true }).catch(() => {});
            }
            await channel.permissionOverwrites.edit(client.user.id, { ViewChannel: true, SendMessages: true, ManageChannels: true, ManageMessages: true }).catch(() => {});

            pendingActions.delete(channel.id);
            // update the confirmation message if this interaction is on the same message, otherwise reply
            try {
              if (interaction.message && interaction.message.id === pending.msgId) {
                await interaction.update({ content: ':lock: ticket closed (confirmed).', components: [], embeds: [] }).catch(() => {});
              } else {
                await interaction.reply({ content: ':lock: ticket closed (confirmed).', ephemeral: true }).catch(() => {});
              }
            } catch {}
            await channel.send(':lock: this ticket has been closed. use Reopen to allow the user to send messages again.');
          } catch (err) {
            console.error('error closing ticket:', err);
            try { await interaction.reply({ content: 'could not close the ticket, check bot permissions.', ephemeral: true }); } catch {}
          }
          return;
        }

        // DELETE CONFIRM
        if (prefix === 'delete') {
          const supportRole = resolveRole(guild, SUPPORT_ROLE_ID);
          const isSupport = supportRole ? member.roles.cache.has(supportRole.id) || member.permissions.has(PermissionsBitField.Flags.Administrator) : member.permissions.has(PermissionsBitField.Flags.Administrator);
          if (!isSupport) return interaction.reply({ content: 'only support can confirm deletes', ephemeral: true });

          // delete channel after small delay
          try {
            // attempt to remove pending and delete confirmation message
            const pendingCopy = pending;
            pendingActions.delete(channel.id);
            try {
              if (interaction.message && interaction.message.id === pendingCopy.msgId) {
                await interaction.update({ content: 'deleting channel in 3s...', components: [], embeds: [] }).catch(() => {});
              } else {
                await interaction.reply({ content: 'deleting channel in 3s...', ephemeral: true }).catch(() => {});
              }
            } catch {}

            setTimeout(async () => {
              try {
                await channel.delete('Ticket deleted by confirmation');
              } catch (err) {
                console.error('failed to delete channel:', err);
                try { await channel.send('failed to delete the channel, check permissions.'); } catch {}
              }
            }, 3000);
          } catch (err) {
            console.error('error deleting ticket:', err);
            try { await interaction.reply({ content: 'could not delete the channel, check bot permissions.', ephemeral: true }); } catch {}
          }
          return;
        }
      }
    }
  } catch (err) {
    console.error('interaction error', err);
    // best-effort reply
    try {
      if (interaction && (interaction.replied || interaction.deferred)) {
        await interaction.followUp({ content: 'there was an error handling the interaction.', ephemeral: true });
      } else if (interaction) {
        await interaction.reply({ content: 'there was an error.', ephemeral: true });
      }
    } catch {}
  }
});

client.login(TOKEN);
