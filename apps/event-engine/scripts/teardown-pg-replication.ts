import { Client } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

async function teardownReplication() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not defined in environment variables');
  }

  const client = new Client({
    connectionString,
  });

  try {
    console.log('Connecting to PostgreSQL...');
    await client.connect();

    console.log('\n🔍 Checking for active replication slots...');
    const slotName = process.env.DEBEZIUM_SLOT ?? 'debezium_slot';
    const slotsQuery = `
      SELECT slot_name, active, restart_lsn, confirmed_flush_lsn
      FROM pg_replication_slots
      WHERE slot_name = '${slotName}'
    `;
    const slotsResult = await client.query(slotsQuery);

    if (slotsResult.rows.length > 0) {
      console.log(`Found ${slotsResult.rows.length} replication slot(s):`);
      slotsResult.rows.forEach(slot => {
        console.log(`  - ${slot.slot_name} (active: ${slot.active})`);
      });

      for (const slot of slotsResult.rows) {
        if (slot.active) {
          console.warn(`⚠️  Slot '${slot.slot_name}' is currently active. It will be dropped anyway.`);
        }
        console.log(`Dropping replication slot '${slot.slot_name}'...`);
        try {
          await client.query(`SELECT pg_drop_replication_slot('${slot.slot_name}')`);
          console.log(`  ✓ Dropped slot '${slot.slot_name}'`);
        } catch (error: any) {
          if (error.message?.includes('is active')) {
            console.error(`  ✗ Cannot drop active slot '${slot.slot_name}'. Stop Debezium first.`);
          } else {
            throw error;
          }
        }
      }
    } else {
      console.log('No Debezium replication slots found.');
    }

    console.log('\n🔍 Checking for publications...');
    const publicationsQuery = `
      SELECT pubname
      FROM pg_publication
      WHERE pubname LIKE 'debezium%'
    `;
    const publicationsResult = await client.query(publicationsQuery);

    if (publicationsResult.rows.length > 0) {
      console.log(`Found ${publicationsResult.rows.length} publication(s):`);
      for (const pub of publicationsResult.rows) {
        console.log(`  - ${pub.pubname}`);
        console.log(`Dropping publication '${pub.pubname}'...`);
        await client.query(`DROP PUBLICATION IF EXISTS ${pub.pubname}`);
        console.log(`  ✓ Dropped publication '${pub.pubname}'`);
      }
    } else {
      console.log('No Debezium publications found.');
    }

    console.log('\n🔍 Checking for replication user...');
    const userQuery = `
      SELECT 1 FROM pg_roles WHERE rolname = 'debezium_replicator'
    `;
    const userResult = await client.query(userQuery);

    if (userResult.rows.length > 0) {
      console.log('Found replication user: debezium_replicator');

      console.log('Revoking permissions...');
      try {
        await client.query('REVOKE ALL ON SCHEMA public FROM debezium_replicator');
        await client.query('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM debezium_replicator');
        console.log('  ✓ Permissions revoked');
      } catch (error: any) {
        console.warn('  ⚠️  Some permissions could not be revoked:', error.message);
      }

      console.log('Dropping user...');
      try {
        await client.query('DROP ROLE IF EXISTS debezium_replicator');
        console.log('  ✓ User dropped');
      } catch (error: any) {
        if (error.message?.includes('cannot be dropped')) {
          console.error('  ✗ Cannot drop user. There might be dependent objects.');
        } else {
          throw error;
        }
      }
    } else {
      console.log('Replication user not found.');
    }

    console.log('\n🔍 Checking WAL size...');
    const walSizeQuery = `
      SELECT
        pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), MIN(restart_lsn))) as wal_retained
      FROM pg_replication_slots
      WHERE restart_lsn IS NOT NULL
    `;
    const walResult = await client.query(walSizeQuery);

    if (walResult.rows.length > 0 && walResult.rows[0].wal_retained) {
      console.log(`WAL space that will be freed: ${walResult.rows[0].wal_retained}`);
    }

    console.log('\n✅ Teardown completed successfully!');
    console.log('\nNote: WAL files will be cleaned up during the next checkpoint.');
    console.log('You can force a checkpoint with: CHECKPOINT;');

  } catch (error) {
    console.error('Error during teardown:', error);
    throw error;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  teardownReplication().catch((error) => {
    console.error('Failed to teardown replication:', error);
    process.exit(1);
  });
}

export { teardownReplication };