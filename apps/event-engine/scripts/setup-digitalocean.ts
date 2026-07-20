#!/usr/bin/env node
import * as dotenv from 'dotenv';
import { Client } from 'pg';

dotenv.config();

async function setupDigitalOcean() {
  console.log(`
╔═══════════════════════════════════════════════════════════════════════╗
║         DigitalOcean Managed Database Setup for Debezium CDC         ║
╚═══════════════════════════════════════════════════════════════════════╝

This script will verify your DigitalOcean managed database is ready for
Debezium Change Data Capture (CDC).
`);

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not defined in environment variables');
  }

  const dbUrlParts = new URL(connectionString);
  const username = dbUrlParts.username;
  const hostname = dbUrlParts.hostname;

  if (!username.includes('doadmin') && !hostname.includes('db.ondigitalocean.com')) {
    console.log('⚠️  This doesn\'t appear to be a DigitalOcean managed database.');
    console.log('    Use npm run setup:pg-replication instead.');
    return;
  }

  const client = new Client({ connectionString });

  try {
    console.log('🔌 Connecting to DigitalOcean database...');
    await client.connect();

    console.log('✅ Connected successfully\n');

    // Check WAL level
    console.log('1️⃣  Checking WAL level configuration...');
    const walResult = await client.query('SHOW wal_level;');
    const walLevel = walResult.rows[0].wal_level;

    if (walLevel === 'logical') {
      console.log(`   ✅ WAL level is set to 'logical' - Ready for CDC!`);
    } else {
      console.log(`   ⚠️  WAL level is '${walLevel}' but should be 'logical'`);
      console.log(`
   To enable logical replication on DigitalOcean:
   1. Go to your database dashboard
   2. Navigate to Settings -> PostgreSQL Configuration
   3. Set 'wal_level' to 'logical'
   4. Wait for the database to restart
      `);
      process.exit(1);
    }

    // Check max_replication_slots
    console.log('\n2️⃣  Checking replication slots configuration...');
    const maxSlotsResult = await client.query('SHOW max_replication_slots;');
    const maxSlots = parseInt(maxSlotsResult.rows[0].max_replication_slots);
    console.log(`   Max replication slots: ${maxSlots}`);

    const currentSlotsResult = await client.query(`
      SELECT COUNT(*) as count FROM pg_replication_slots
    `);
    const currentSlots = parseInt(currentSlotsResult.rows[0].count);
    console.log(`   Current slots in use: ${currentSlots}`);
    console.log(`   Available slots: ${maxSlots - currentSlots}`);

    if (maxSlots - currentSlots < 1) {
      console.log(`   ⚠️  No available replication slots!`);
      console.log(`      Increase max_replication_slots in your DigitalOcean dashboard.`);
    } else {
      console.log(`   ✅ Replication slots available`);
    }

    // Check max_wal_senders
    console.log('\n3️⃣  Checking WAL senders configuration...');
    const maxSendersResult = await client.query('SHOW max_wal_senders;');
    const maxSenders = parseInt(maxSendersResult.rows[0].max_wal_senders);
    console.log(`   Max WAL senders: ${maxSenders}`);

    const currentSendersResult = await client.query(`
      SELECT COUNT(*) as count FROM pg_stat_replication
    `);
    const currentSenders = parseInt(currentSendersResult.rows[0].count);
    console.log(`   Current senders in use: ${currentSenders}`);
    console.log(`   Available senders: ${maxSenders - currentSenders}`);

    if (maxSenders - currentSenders < 1) {
      console.log(`   ⚠️  No available WAL senders!`);
      console.log(`      Increase max_wal_senders in your DigitalOcean dashboard.`);
    } else {
      console.log(`   ✅ WAL senders available`);
    }

    // Check user permissions
    console.log('\n4️⃣  Checking user permissions...');
    const userResult = await client.query(`
      SELECT current_user,
             has_database_privilege(current_user, current_database(), 'CONNECT') as can_connect,
             has_table_privilege(current_user, 'pg_replication_slots', 'SELECT') as can_read_slots
    `);
    const userInfo = userResult.rows[0];
    console.log(`   Current user: ${userInfo.current_user}`);
    console.log(`   Can connect: ${userInfo.can_connect ? '✅' : '❌'}`);
    console.log(`   Can read replication slots: ${userInfo.can_read_slots ? '✅' : '❌'}`);

    // List tables we'll be monitoring
    console.log('\n5️⃣  Verifying tables exist...');
    const tables = [
      'UserEngagement',
      'Model',
      'ModelVersion',
      'Post',
      'Image'
    ];

    let missingTables = [];
    for (const table of tables) {
      const result = await client.query(`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public'
          AND table_name = $1
        ) as exists
      `, [table]);

      if (result.rows[0].exists) {
        console.log(`   ✅ ${table}`);
      } else {
        console.log(`   ❌ ${table} - not found`);
        missingTables.push(table);
      }
    }

    // Summary
    console.log(`
╔═══════════════════════════════════════════════════════════════════════╗
║                           Setup Summary                              ║
╚═══════════════════════════════════════════════════════════════════════╝
`);

    if (walLevel === 'logical' &&
        maxSlots - currentSlots >= 1 &&
        maxSenders - currentSenders >= 1 &&
        missingTables.length === 0) {
      console.log(`✅ Your DigitalOcean database is ready for Debezium CDC!

Next steps:
1. Start Docker services:     docker-compose up -d
2. Setup Debezium connector:  npm run setup:debezium
3. Test event consumption:    npm run consumer:test

Debezium will use these credentials:
- Host: ${hostname}
- Port: ${dbUrlParts.port || '25060'}
- Database: ${dbUrlParts.pathname.slice(1).split('?')[0]}
- Username: ${username}
- Password: [from DATABASE_URL]
`);
    } else {
      console.log(`⚠️  Some issues need to be resolved:
`);
      if (walLevel !== 'logical') {
        console.log(`❌ Set wal_level to 'logical' in DigitalOcean dashboard`);
      }
      if (maxSlots - currentSlots < 1) {
        console.log(`❌ Increase max_replication_slots`);
      }
      if (maxSenders - currentSenders < 1) {
        console.log(`❌ Increase max_wal_senders`);
      }
      if (missingTables.length > 0) {
        console.log(`❌ Missing tables: ${missingTables.join(', ')}`);
      }
      console.log(`
After fixing these issues, run this script again to verify.`);
    }

  } catch (error) {
    console.error('Error:', error);
    throw error;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  setupDigitalOcean().catch((error) => {
    console.error('Setup failed:', error);
    process.exit(1);
  });
}

export { setupDigitalOcean };