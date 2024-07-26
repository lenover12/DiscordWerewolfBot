import pkg from "discord.js";
const {
  Client,
  GatewayIntentBits,
  Partials,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ComponentType,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
} = pkg;
import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v9";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

// const activeGames = new Map();

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.resolve(__dirname, "game_data.sqlite");

const initDatabase = async () => {
  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database,
  });

  await db.exec(`
        CREATE TABLE IF NOT EXISTS games (
            channelId TEXT PRIMARY KEY,
            isActive BOOLEAN,
            currentPhase TEXT
        );
        CREATE TABLE IF NOT EXISTS players (
            id TEXT,
            gameId TEXT,
            isDead BOOLEAN,
            role TEXT,
            name TEXT,
            votedFor TEXT,
            PRIMARY KEY (id, gameId),
            FOREIGN KEY (gameId) REFERENCES games(channelId)
        );
    `);

  return db;
};

const db = await initDatabase();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  partials: [Partials.Channel],
});

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

const commands = [
  {
    name: "werewolf",
    description: "Start a new game of Werewolf",
  },
  {
    name: "accesssoundboard",
    description: "Grant access to the soundboard",
  },
];

const rest = new REST({ version: "9" }).setToken(token);

(async () => {
  try {
    console.log("Started refreshing application (/) commands.");

    await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
      body: commands,
    });

    console.log("Successfully reloaded application (/) commands.");
  } catch (error) {
    console.error(error);
  }
})();

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand()) return;

  const { commandName, user } = interaction;

  if (commandName === "werewolf") {
    // Create a new private voice channel
    const voiceChannel = await interaction.guild.channels.create({
      name: "Werewolf Game",
      type: ChannelType.GuildVoice,
      parent: "1258271630321385544",
      permissionOverwrites: [
        {
          id: interaction.guild.id,
          deny: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: user.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
        },
      ],
    });

    // Add start button in the voice channel text chat
    const startGameBtn = new ButtonBuilder()
      .setCustomId(`start_werewolf_${voiceChannel.id}`)
      .setLabel("Start Game")
      .setStyle(ButtonStyle.Success);

    const startButtonRow = new ActionRowBuilder().addComponents(startGameBtn);

    await voiceChannel.send({
      content: "Click to start the game!",
      components: [startButtonRow],
    });

    // Set up game loop when start button is clicked
    const startFilter = (i) =>
      i.customId === `start_werewolf_${voiceChannel.id}` &&
      i.user.id === user.id;
    const startCollector = voiceChannel.createMessageComponentCollector({
      filter: startFilter,
      time: 120000, // 2 minutes
    });

    // Create a button to join the voice channel
    const joinWerewolf = new ButtonBuilder()
      .setCustomId(`join_werewolf_${voiceChannel.id}`)
      .setLabel("Join Werewolf Game")
      .setStyle(ButtonStyle.Primary);

    const joinButtonRow = new ActionRowBuilder().addComponents(joinWerewolf);

    const joinMessage = await interaction.reply({
      content: "Join the Werewolf channel!",
      components: [joinButtonRow],
    });

    // Listen for button interaction to join voice channel
    const filter = (i) => i.customId === `join_werewolf_${voiceChannel.id}`;
    const collector = interaction.channel.createMessageComponentCollector({
      filter,
      time: 120000, // 2 minutes
    });

    collector.on("collect", async (i) => {
      if (i.customId === `join_werewolf_${voiceChannel.id}`) {
        const member = await interaction.guild.members.fetch(i.user.id);

        // Check the user is already added to the game
        const player = await db.get(
          "SELECT * FROM players WHERE id = ? AND gameId = ?",
          member.id,
          channelId
        );

        if (player) {
          // Give the member permissions to view and send messages in the text channel
          await voiceChannel.permissionOverwrites.create(member, {
            [PermissionFlagsBits.ViewChannel]: true,
            [PermissionFlagsBits.Connect]: true,
            [PermissionFlagsBits.SendMessages]: true,
          });

          await i.reply({
            content: "added! find the game in voice games channels! :smile:",
            components: [],
            ephemeral: true,
          });

          // Add the player to the database
          await db.run(
            "INSERT INTO players (id, gameId, isDead, role, name, votedFor) VALUES (?, ?, ?, ?, ?, ?)",
            member.id,
            voiceChannel.id,
            false,
            "",
            member.user.username,
            null
          );
        }
      }
    });
    startCollector.on("collect", async (i) => {
      if (i.customId === `start_werewolf_${voiceChannel.id}`) {
        try {
          await i.update({
            content: "Game starting...",
            components: [],
          });
        } catch (error) {
          console.error("Error updating interaction:", error);
        }

        // Delete the joinWerewolf button message
        if (joinMessage) {
          joinMessage.delete();
        }

        // Initialize game state in the database
        await db.run(
          "INSERT INTO games (channelId, isActive, currentPhase) VALUES (?, ?, ?)",
          voiceChannel.id,
          true,
          "setup"
        );

        // Assign roles to players
        // const members = Array.from(voiceChannel.members.values());
        // await assignRoles(members, voiceChannel.id);

        // Start game loop
        startNewGame(voiceChannel.id);
      }
    });

    collector.on("end", (collected) => {
      try {
        if (collected.size === 0) {
          interaction.followUp({
            content: "No one joined the voice channel in time.",
            components: [],
          });
          voiceChannel.delete();
        }
      } catch (error) {
        console.error(
          `collector end for interactionCreate with channelId: ${channelId} had error: ${error}`
        );
      }
    });
  }

  // Handle 'accesssoundboard' command
  if (commandName === "accesssoundboard") {
    try {
      // Check if the user is in any active game
      const activeGames = await db.all(
        "SELECT * FROM games WHERE isActive = 1"
      );
      const userGames = await db.all(
        "SELECT * FROM players WHERE id = ?",
        user.id
      );

      const isInActiveGame = userGames.some((player) =>
        activeGames.some((game) => game.channelId === player.gameId)
      );

      if (!isInActiveGame) {
        // Grant soundboard permissions
        await interaction.guild.members.fetch(user.id); // Fetch member details

        await interaction.member.permissions.add(["USE_SOUNDBOARD"]);
        await interaction.reply(
          "You have been granted access to the soundboard."
        );
      } else {
        await interaction.reply(
          "You cannot have soundboard access while you are a player of an active game."
        );
      }
    } catch (error) {
      console.error("Error accessing database:", error);
      await interaction.reply("There was an error processing your request.");
    }
  }
});

// Function to start a new game
const startNewGame = async (channelId) => {
  // Initialize game state
  let game = {
    channelId: channelId,
    isActive: true,
    currentPhase: "setup",
    roundCollectors: [],
    gameCollectors: [],
  };

  //store game in activeGames map
  // activeGames.set(channelId, game);

  // Start game loop for this game
  gameLoop(game);
};

const assignRoles = async (channelId) => {
  const players = await db.all(
    "SELECT id FROM players WHERE gameId = ?",
    channelId
  );

  const werewolfCount = Math.floor(players.length / 4); // Adjust as per your game rules
  const roles = ["werewolf", "doctor", "detective", "civilian"];

  // Shuffle roles
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }

  for (let i = 0; i < players.length; i++) {
    const role = i < werewolfCount ? "werewolf" : roles[i - werewolfCount];
    const playerId = players[i].id;

    // Update player role in the database
    await db.run(
      "UPDATE players SET role = ? WHERE id = ? AND gameId = ?",
      role,
      playerId,
      channelId
    );
  }

  return players.length;
};

// feedback on player roles
const feedbackRoles = async (game) => {
  //get the channelId
  const channelId = game.channelId;

  // Create and send the role check button
  const roleCheckButton = new ButtonBuilder()
    .setCustomId(`check_role_${channelId}`)
    .setLabel("Check Your Role")
    .setStyle(ButtonStyle.Danger);

  const roleCheckButtonRow = new ActionRowBuilder().addComponents(
    roleCheckButton
  );

  const channel = client.channels.cache.get(channelId);
  if (channel) {
    const roleCheckMessage = await channel.send({
      content: "Click the button to check your role.",
      components: [roleCheckButtonRow],
    });

    // Set up a collector for the role check button
    const filter = (i) => i.customId === `check_role_${channelId}`;
    const collector = channel.createMessageComponentCollector({
      filter,
      time: 600000,
    }); // 10 minutes

    collector.on("collect", async (i) => {
      const playerId = i.user.id;

      // Fetch player role from database based on user.id and channelId
      const player = await db.get(
        "SELECT role FROM players WHERE id = ? AND gameId = ?",
        playerId,
        channelId
      );

      if (player) {
        let response = "";
        switch (player.role) {
          case "werewolf":
            response =
              "You are a Werewolf. Work with your team to eliminate the villagers!";
            break;
          case "doctor":
            response =
              "You are the Doctor. Protect villagers from werewolf attacks!";
            break;
          case "detective":
            response =
              "You are the Detective. Investigate players to find the werewolves!";
            break;
          case "civilian":
            response =
              "You are a Civilian. Stay alive and try to identify the werewolves!";
            break;
          default:
            response = "Your role information is not available.";
            break;
        }

        // Send ephemeral message to the player
        await i.reply({
          content: response,
          ephemeral: true,
        });
      } else {
        console.error(
          `Player ${playerId} not found in the database for channel ${channelId}.`
        );
        await i.reply({
          content: "Your role information is not available.",
          ephemeral: true,
        });
      }
    });

    collector.on("end", () => {
      try {
        if (roleCheckMessage) {
          roleCheckMessage.edit({
            content: "The role check button is no longer active.",
            components: [],
          });
        }
      } catch (error) {
        console.error(
          `collector end for feebackRoles with channelId: ${channelId} had error: ${error} `
        );
      }
    });

    //add the collector to the game state
    game.gameCollectors.push(collector);
  } else {
    console.error(`Channel with ID ${channelId} not found.`);
  }
};

// UpdateDB with Vote
const addVoteToDB = async (channelId, playerId, targetId) => {
  // Update player role in the database
  await db.run(
    "UPDATE players SET votedFor = ? WHERE id = ? AND gameId = ?",
    targetId,
    playerId,
    channelId
  );
};

// Night Vote
const nightVote = async (game, voteTimer) => {
  //get channelId
  const channelId = game.channelId;

  // Fetch all players in the game
  const players = await db.all(
    "SELECT id, name FROM players WHERE gameId = ? AND isDead = ?",
    channelId,
    false
  );

  // Create buttons for each player
  const voteButtonRow = new ActionRowBuilder();
  players.forEach((player) => {
    const voteButton = new ButtonBuilder()
      .setCustomId(`vote_${channelId}_${player.id}`)
      .setLabel(player.name)
      .setStyle(ButtonStyle.Primary); // You can change the style as needed

    voteButtonRow.addComponents(voteButton);
  });

  const channel = client.channels.cache.get(channelId);
  if (channel) {
    const voteMessage = await channel.send({
      content: "Click a button to vote for a player.",
      components: [voteButtonRow],
    });

    // Set up a collector for the vote buttons
    const filter = (i) => i.customId.startsWith(`vote_${channelId}_`);
    const collector = channel.createMessageComponentCollector({
      filter,
      time: voteTimer, // 30 seconds
    });

    collector.on("collect", async (i) => {
      const [_, __, targetPlayerId] = i.customId.split("_"); // Extract the target player ID from custom ID
      const presserPlayerId = i.user.id; // Get the presser's player ID

      // Do something with targetPlayerId and presserPlayerId
      console.log(
        `Player ${presserPlayerId} voted for Player ${targetPlayerId}`
      );

      //TODO: change the SELECT role, we need the isDead
      //TODO: make the voters ONLY able to vote if they are not dead

      // Fetch player role from database based on user.id and channelId
      const presserPlayer = await db.get(
        "SELECT role, name FROM players WHERE id = ? AND gameId = ? AND isDead = ?",
        presserPlayerId,
        channelId,
        false
      );

      // Fetch player role from database based on user.id and channelId
      const targetPlayer = await db.get(
        "SELECT role, name FROM players WHERE id = ? AND gameId = ? AND isDead = ?",
        targetPlayerId,
        channelId,
        false
      );

      if (presserPlayer && targetPlayer) {
        let response = "";
        switch (presserPlayer.role) {
          case "werewolf":
            if (targetPlayer.role === "werewolf") {
              if (presserPlayer.id != targerPlayer.id) {
                response = `You cannot kill ${targetPlayer.name}, they are in your pack!`;
              } else {
                reponse = `Self cannibalism is frowned upon in wolf society`;
              }
              //set presserPlayers target to empty
              addVoteToDB(channelId, presserPlayerId, null);
            } else {
              response = `targetting ${targetPlayer.name}`;
              //set presserPlayers target to targetPlayer
              addVoteToDB(channelId, presserPlayerId, targetPlayerId);
            }
            break;
          case "doctor":
            if (targetPlayerId === presserPlayerId) {
              response = `Protecting yourself you dirty dog!`;
              //set presserPlayers target to targetPlayer
              addVoteToDB(channelId, presserPlayerId, targetPlayerId);
            } else {
              response = `Protecting ${targetPlayer.name}`;
              //set presserPlayers target to targetPlayer
              addVoteToDB(channelId, presserPlayerId, targetPlayerId);
            }
            break;
          case "detective":
            if (targetPlayerId === presserPlayerId) {
              response = `You cannot investigate yourself...`;
              //set presserPlayers target to targetPlayer
              addVoteToDB(channelId, presserPlayerId, null);
            } else if (targetPlayer.role === "detective") {
              response = `You know ${targetPlayer.name} is clear, you went through your detective cert I together afterall`;
              //set presserPlayers target to empty
              addVoteToDB(channelId, presserPlayerId, null);
            } else {
              response = `Investigating ${targetPlayer.name}`;
              //set presserPlayers target to targetPlayer
              addVoteToDB(channelId, presserPlayerId, targetPlayerId);
            }
            break;
          case "civilian":
            const responses = [
              `You are a tepid boring civilian with no voting rights, sit ${presserPlayer.name}`,
              `You are very pedestrian, stick to your useless role, sit ${presserPlayer.name}`,
              `Someone trite like you couldn't possibly think you can contribute, sit ${presserPlayer.name}`,
              `Pointlessly picking names because you are bored of your stale existence? sit ${presserPlayer.name}`,
            ];

            // Select a random response
            const randomIndex = Math.floor(Math.random() * responses.length);
            response = responses[randomIndex];
            break;
        }

        // Send ephemeral message to the player
        await i.reply({
          content: response,
          ephemeral: true,
        });
      } else {
        console.error(
          `Player ${playerId} not found in the database for channel ${channelId}.`
        );
        await i.reply({
          content: "Your role information is not available.",
          ephemeral: true,
        });
      }
    });

    collector.on("end", () => {
      try {
        voteMessage.edit({
          content: "The voting period has ended.",
          components: [],
        });
      } catch (error) {
        console.error(
          `collector end for nightVote with channelID: ${channelId} had error: ${error}.`
        );
      }
    });

    game.roundCollectors.push(collector);
  } else {
    console.error(`Channel with ID ${channelId} not found.`);
  }
};

// Game loop function
async function gameLoop(game) {
  // Loop until game is active

  //TODO: collectors in array
  //TODO: stop collectors after they are no longer needed or before being reassigned
  while (game.isActive) {
    switch (game.currentPhase) {
      case "setup":
        const playerCount = await assignRoles(game.channelId);
        await introduceWerewolf(game.channelId);
        await feedbackRoles(game);
        if (playerCount <= 3) {
          game.currentPhase = "night";
        } else {
          game.currentPhase = "night";
        }
        break;
      case "night":
        await nightPhase(game);
        game.currentPhase = "day";
        break;
      case "day":
        await dayPhase(game.channelId);
        game.currentPhase = "sunset";
        break;
      case "sunset":
        await resetVotes(game.channelId);
        await checkGameState(game.channelId);
        game.currentPhase = "end";
        break;
      case "end":
        game.isActive = false;
        break;
      default:
        break;
    }

    // Update game state in database
    await db.run(
      "UPDATE games SET isActive = ?, currentPhase = ? WHERE channelId = ?",
      game.isActive,
      game.currentPhase,
      game.channelId
    );
  }

  // Clean up game resources (delete channel, clear database, etc.)
  await db.run("DELETE FROM games WHERE channelId = ?", game.channelId);
  await db.run("DELETE FROM players WHERE gameId = ?", game.channelId);
  const channel = client.channels.cache.get(game.channelId);
  //turn this into an array of collectors to iterate through without needing the name
  // stopCollector(game.collectorVote);
  // stopCollector(game.roleFeedbackCollector);
  await stopAllCollectors(game.roundCollectors);
  await stopAllCollectors(game.gameCollectors);
  if (channel) {
    await channel.delete();
  }
}

// Utility function to safely stop a collector
const stopCollector = (collector) => {
  if (collector && !collector.ended) {
    collector.stop();
  }
};

// Utility function to stop all collectors
async function stopAllCollectors(collectors) {
  for (const collector of collectors) {
    await collector.stop();
  }
  //clear the array without reassigning it
  collectors.length = 0;
}

const playerQuotes = [
  "what a champion",
  "puts the fun in 'fun'",
  "excellence incarnate",
  "always welcome",
  "vibes well",
  "pure sunshine",
  "sparkles with charisma",
  "embraces life's zest",
  "a delight magnet",
  "the soul of spontaneity",
  "spreads contagious laughter",
  "a perpetual smile",
  "defines joie de vivre",
  "a burst of energy",
  "lights up the room",
  "irresistibly vibrant",
  "a walking celebration",
  "effortlessly cool",
  "a master of charm",
  "the epitome of grace",
  "a joy amplifier",
  "a melody of positivity",
  "an endless adventure",
  "brims with enthusiasm",
  "a symphony of kindness",
];

// Function to introduce werewolf game in the text channel of a voice channel
async function introduceWerewolf(channelId) {
  // Query the database to get all players' roles for the current game
  const players = await db.all(
    "SELECT * FROM players WHERE gameId = ?",
    channelId
  );

  // Get channel
  const channel = client.channels.cache.get(channelId);

  // Fetch member details for each player
  const memberPromises = players.map(async (player) => {
    try {
      return await client.users.fetch(player.id);
    } catch (error) {
      console.error(`Error fetching member details for ${player.id}:`, error);
      return null;
    }
  });

  // Get players names
  const members = await Promise.all(memberPromises);
  const validMembers = members.filter((member) => member !== null);

  console.log(players);

  // Count the number of each role
  const roleCounts = players.reduce((counts, player) => {
    counts[player.role] = (counts[player.role] || 0) + 1;
    return counts;
  }, {});

  // Construct the message with correct plurals and excluding any roles that don't exist
  const rolesInfo = [];
  if (roleCounts.werewolf) {
    rolesInfo.push(
      `${roleCounts.werewolf} werewolf${roleCounts.werewolf > 1 ? "s" : ""}`
    );
  }
  if (roleCounts.doctor) {
    rolesInfo.push(
      `${roleCounts.doctor} doctor${roleCounts.doctor > 1 ? "s" : ""}`
    );
  }
  if (roleCounts.detective) {
    rolesInfo.push(
      `${roleCounts.detective} detective${roleCounts.detective > 1 ? "s" : ""}`
    );
  }
  if (roleCounts.civilian) {
    rolesInfo.push(
      `${roleCounts.civilian} civilian${roleCounts.civilian > 1 ? "s" : ""}`
    );
  }

  // Message content to send
  const messageGameInfo = `Welcome to the game of Werewolf, this game has ${rolesInfo.join(
    ", "
  )}, let's play!`;

  const messageIntroNarration =
    "Nestled amidst whispering forests and moonlit glades, lies a village where shadows dance with secrets beneath the flickering glow of lanterns.";

  try {
    if (channel) {
      // Create an embed
      const embed = new EmbedBuilder()
        .setTitle("Game Information")
        .setDescription("Welcome to the game of Werewolf!")
        .setColor(0x00ae86);

      // Add fields for each player with their profile image and username
      validMembers.forEach((member) => {
        const randomQuote =
          playerQuotes[Math.floor(Math.random() * playerQuotes.length)];
        embed.addFields({
          name: member.username,
          value: randomQuote,
          inline: true,
        });
        embed.setThumbnail(
          member.displayAvatarURL({ format: "png", dynamic: true })
        );
      });

      // Send the TTS message to the text channel
      await notifyChannel(channelId, messageGameInfo, { tts: true });

      // Send the embed message to the text channel
      await channel.send({ embeds: [embed] });

      // wait for the message to be read
      await sleep(1000);

      // send the TTS message to the text channel
      await notifyChannel(channelId, messageIntroNarration, { tts: true });
    } else {
      console.error(`Channel with ID ${channelId} not found.`);
    }
    // wait for the message to be read
    await sleep(1000);
  } catch (error) {
    console.error("Error introducing werewolf game:", error);
  }
}

// Function to update the countdown message
const updateCountdownMessage = async (message, remainingTime) => {
  const minutes = Math.floor(remainingTime / 60);
  const seconds = remainingTime % 60;
  await message.edit(
    `Time remains: ${minutes}:${seconds < 10 ? "0" : ""}${seconds}`
  );
};

// Night phase logic
async function nightPhase(game) {
  //get channelId
  const channelId = game.channelId;

  console.log(`Night phase started for channel ${channelId}.`);

  // Count roles of all players dead and alive

  // Construct night phase message

  // Notify the channel with a TTS message
  await notifyChannel(
    channelId,
    "Night phase has started. Werewolves, make your move!",
    { tts: true }
  );

  // Time for voting
  const voteTimer = 10000;

  // Start the voting for the night phase
  await nightVote(game, voteTimer);

  // Send the initial countdown message without TTS
  const channel = client.channels.cache.get(channelId);
  if (!channel) {
    console.error(`Channel with ID ${channelId} not found.`);
    return;
  }

  // Countdown Timer
  let remainingTime = voteTimer / 1000;
  const countdownMessage = await channel.send(`Time remains: ${remainingTime}`);

  // Update the countdown every second for 30 seconds
  for (remainingTime; remainingTime >= 0; remainingTime--) {
    await updateCountdownMessage(countdownMessage, remainingTime);
    await sleep(1000); // Wait for 1 second
  }

  // collector.on("end", () => {
  //   voteMessage.edit({
  //     content: "The voting period has ended.",
  //     components: [],
  //   });
  // });

  // Stop the collector when the timer hits 0
  stopAllCollectors(game.roundCollectors);

  // Update game state for next phase
  await db.run(
    "UPDATE games SET currentPhase = 'day' WHERE channelId = ?",
    channelId
  );
}

async function resetVotes(channelId) {
  // Update game state for next phase
  await db.run(
    "UPDATE players SET votedFor = null WHERE gameId = ?",
    channelId
  );
}

async function checkGameState(channelId) {
  //get the current roles of all players
  //check if there are any werewolves
  //check if there are more werewolves than non werewolves
  //continue || construct ending message

  // Update game state for next phase
  await db.run(
    "UPDATE games SET currentPhase = 'night' WHERE channelId = ?",
    channelId
  );
}

// Handle the end of the voting period
async function handleVoteEnd(channelId) {
  // Fetch all players in the game
  const players = await db.all(
    "SELECT id, role, votedFor, name FROM players WHERE gameId = ?",
    channelId
  );

  // Separate players by roles, including only those who contributed
  const werewolves = players.filter(
    (player) => player.role === "werewolf" && player.votedFor !== null
  );
  const doctors = players.filter(
    (player) => player.role === "doctor" && player.votedFor !== null
  );
  const detectives = players.filter(
    (player) => player.role === "detective" && player.votedFor !== null
  );

  // Determine werewolves' target
  const werewolfVotes = werewolves
    .map((wolf) => wolf.votedFor)
    .filter((vote) => vote !== null);

  let werewolfChoice = null;

  // werewolfChoice[0] is most voted for
  // werewolfChoice.length !== 1 means not mutual choice
  if (werewolfVotes.length > 0) {
    const voteCounts = werewolfVotes.reduce((acc, vote) => {
      acc[vote] = (acc[vote] || 0) + 1;
      return acc;
    }, {});

    werewolfChoice = Object.keys(voteCounts).sort(
      (a, b) => voteCounts[b] - voteCounts[a]
    );
  }

  let werewolfMessage = "";

  if (werewolfChoice === null || werewolfVotes.length === 0) {
    werewolfMessage =
      "Whatever is out there is biding its time, no one was harmed this night.";
  } else if (werewolfChoice.length !== 1) {
    werewolfMessage =
      "There were sounds of struggle, but no villagers were harmed this night.";
  } else {
    // Determine doctors' actions
    const doctorVotes = doctors
      .map((doc) => doc.votedFor)
      .filter((vote) => vote !== null);

    let doctorChoice = null;

    // doctorChoice[0] is most voted for
    // doctorChoice.length !== 1 means not mutual choice
    if (doctorVotes.length > 0) {
      const voteCounts = doctorVotes.reduce((acc, vote) => {
        acc[vote] = (acc[vote] || 0) + 1;
        return acc;
      }, {});

      doctorChoice = Object.keys(voteCounts).sort(
        (a, b) => voteCounts[b] - voteCounts[a]
      );
    }

    if (doctorChoice && doctorChoice[0] === werewolfChoice[0]) {
      werewolfMessage = `${
        players.find((p) => p.id === werewolfChoice[0]).name
      } was attacked by werewolves and lay dying, but was mysteriously saved.`;
    } else if (
      doctorChoice &&
      doctorChoice.length > 1 &&
      doctorChoice.includes(werewolfChoice[0])
    ) {
      werewolfMessage = `${
        players.find((p) => p.id === werewolfChoice[0]).name
      } was found dead. It appears that someone arrived on the scene but was unable to save them this time.`;
      await db.run(
        "UPDATE players SET isDead = ? WHERE id = ? AND gameId = ?",
        true,
        werewolfChoice[0],
        channelId
      );
    } else {
      werewolfMessage = `Everyone notices ${
        players.find((p) => p.id === werewolfChoice[0]).name
      } has not appeared in town this day. ${
        players.find((p) => p.id === werewolfChoice[0]).name
      } is dead.`;
      await db.run(
        "UPDATE players SET isDead = ? WHERE id = ? AND gameId = ?",
        true,
        werewolfChoice[0],
        channelId
      );
    }
  }

  // Determine detectives' actions
  // Determine werewolves' target
  const detectiveVotes = detectives
    .map((sherlock) => sherlock.votedFor)
    .filter((vote) => vote !== null);

  let detectiveChoice = null;

  // detectiveChoice[0] is most voted for
  // detectiveChoice.length !== 1 means not mutual choice
  if (detectiveVotes.length > 0) {
    const voteCounts = detectiveVotes.reduce((acc, vote) => {
      acc[vote] = (acc[vote] || 0) + 1;
      return acc;
    }, {});

    detectiveChoice = Object.keys(voteCounts).sort(
      (a, b) => voteCounts[b] - voteCounts[a]
    );
  }

  let detectiveMessage = "";

  if (detectiveChoice === null || detectiveVotes.length === 0) {
    detectiveMessage = "The detectives did not investigate anyone last night.";
  } else if (detectiveChoice && detectiveChoice.length === 1) {
    const targetPlayer = players.find((p) => p.id === detectiveChoice[0]);
    if (targetPlayer.role === "werewolf") {
      if (werewolfChoice.length === 1) {
        detectiveMessage =
          "This crime was witnessed, someone knows who the culprit is.";
      } else if (werewolfChoice.length > 1) {
        detectiveMessage =
          "A scuffel of disorderly wolves lead one of them to be discovered.";
      } else {
        detectiveMessage =
          "A cleaver investigation lead someone to learn who is a dangerous wolf";
      }
    } else {
      detectiveMessage = "Heavy scrutiny was focused on an innocent person.";
    }
  } else {
    detectiveMessage =
      "This attack may have been witnessed, but organization waned and distractions arose.";
  }

  // Construct the full narration
  let narration = `As the early sun rises and dew covers the fields\n\n${werewolfMessage}\n\n${detectiveMessage}\n\n`;
  await notifyChannel(channelId, narration, { tts: true });
  narration =
    "The day begins, and the villagers gather to discuss the events of the night.";
  await notifyChannel(channelId, narration, { tts: true });
}

// Day phase logic
async function dayPhase(channelId) {
  // Handle the end of the voting period
  // await handleVoteEnd(channelId);

  console.log(`Day phase started for channel ${channelId}.`);

  // Handle the end of the voting period
  await handleVoteEnd(channelId);

  //work out any deaths, detectives, doctors
  //change the isDead to players who failed to live
  //use the fact that they died in the narration/ or were saved

  // await notifyChannel(channelId, "Day phase has started. Discuss and vote!");

  // Wait for 10 seconds (adjust as per your game's timing)
  await sleep(10000);

  // Check win conditions and proceed accordingly...
  console.log(`Day phase ended for channel ${channelId}.`);
  // Update game state for next phase or end game
  await db.run(
    "UPDATE games SET currentPhase = 'sunset' WHERE channelId = ?",
    channelId
  );
}

// Utility function for sleep
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Utility function to send a message to a channel with TTS
async function notifyChannel(channelId, message, options = {}) {
  const channel = client.channels.cache.get(channelId);
  if (channel) {
    await channel.send({
      content: message,
      tts: options.tts || false,
    });
  }
}

client.login(token);
