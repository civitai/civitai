#!/usr/bin/env node

/**
 * Stripe API CLI
 *
 * Look up customers, subscriptions, payments, and perform support actions.
 * Requires STRIPE_SECRET_KEY env var.
 *
 * Usage: node query.mjs <command> [options]
 */

import https from 'https';
import './load-env.mjs';

// ── Config ──────────────────────────────────────────────────────────────────

const SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (!SECRET_KEY) {
  console.error('Error: STRIPE_SECRET_KEY env var is required');
  console.error('Set it in .claude/skills/stripe/.env or as an environment variable');
  process.exit(1);
}

const API_VERSION = '2022-11-15';
let jsonOutput = false;

// ── HTTP helpers ────────────────────────────────────────────────────────────

function request(method, path, params = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(`https://api.stripe.com${path}`);

    let body = null;
    if (params && method === 'GET') {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    } else if (params && method !== 'GET') {
      body = encodeParams(params);
    }

    const options = {
      method,
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        'Authorization': `Bearer ${SECRET_KEY}`,
        'Stripe-Version': API_VERSION,
      },
    };

    if (body) {
      options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      options.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(`Stripe API error: ${parsed.error.message} (${parsed.error.type})`));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`Invalid JSON response: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Encode nested params into Stripe's form encoding format.
 * e.g. { items: [{ id: 'si_xxx' }] } => 'items[0][id]=si_xxx'
 */
function encodeParams(obj, prefix = '') {
  const parts = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (value === undefined || value === null) continue;
    if (typeof value === 'object' && !Array.isArray(value)) {
      parts.push(encodeParams(value, fullKey));
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item === 'object') {
          parts.push(encodeParams(item, `${fullKey}[${i}]`));
        } else {
          parts.push(`${encodeURIComponent(`${fullKey}[${i}]`)}=${encodeURIComponent(item)}`);
        }
      });
    } else {
      parts.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(value)}`);
    }
  }
  return parts.filter(Boolean).join('&');
}

function get(path, params) { return request('GET', path, params); }
function post(path, params) { return request('POST', path, params); }
function del(path, params) { return request('DELETE', path, params); }

// ── Formatting helpers ─────────────────────────────────────────────────────

function ts(epoch) {
  if (!epoch) return 'N/A';
  return new Date(epoch * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function cents(amount) {
  if (amount == null) return 'N/A';
  return `$${(amount / 100).toFixed(2)}`;
}

function out(data) {
  if (jsonOutput) {
    console.log(JSON.stringify(data, null, 2));
  } else if (typeof data === 'string') {
    console.log(data);
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

function die(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

// ── Commands ────────────────────────────────────────────────────────────────

/**
 * Look up a Stripe customer by email address.
 * Returns customer details, active subscriptions, and recent charges.
 */
async function customerLookup(email) {
  if (!email) die('Email is required. Usage: node query.mjs customer <email>');

  // Search for customers by email
  const customers = await get('/v1/customers', { email, limit: 10 });

  if (!customers.data || customers.data.length === 0) {
    out(`No Stripe customer found for email: ${email}`);
    return;
  }

  for (const customer of customers.data) {
    console.log('═'.repeat(70));
    console.log(`CUSTOMER: ${customer.name || '(no name)'}`);
    console.log('═'.repeat(70));
    console.log(`  ID:          ${customer.id}`);
    console.log(`  Email:       ${customer.email}`);
    console.log(`  Name:        ${customer.name || 'N/A'}`);
    console.log(`  Created:     ${ts(customer.created)}`);
    console.log(`  Currency:    ${customer.currency || 'N/A'}`);
    console.log(`  Balance:     ${cents(customer.balance)}`);
    console.log(`  Delinquent:  ${customer.delinquent}`);
    if (customer.metadata && Object.keys(customer.metadata).length > 0) {
      console.log(`  Metadata:    ${JSON.stringify(customer.metadata)}`);
    }
    if (customer.default_source) {
      console.log(`  Def Source:  ${customer.default_source}`);
    }

    // Fetch subscriptions
    const subs = await get('/v1/subscriptions', { customer: customer.id, limit: 10, status: 'all' });
    if (subs.data && subs.data.length > 0) {
      console.log(`\n  SUBSCRIPTIONS (${subs.data.length}):`);
      for (const sub of subs.data) {
        const product = sub.items?.data?.[0]?.price?.product;
        const priceId = sub.items?.data?.[0]?.price?.id;
        const interval = sub.items?.data?.[0]?.price?.recurring?.interval;
        const amount = sub.items?.data?.[0]?.price?.unit_amount;
        console.log(`  ─────────────────────────────────────────`);
        console.log(`    Sub ID:         ${sub.id}`);
        console.log(`    Status:         ${sub.status}`);
        console.log(`    Price:          ${priceId} (${cents(amount)}/${interval || 'one-time'})`);
        console.log(`    Product:        ${product}`);
        console.log(`    Created:        ${ts(sub.created)}`);
        console.log(`    Period:         ${ts(sub.current_period_start)} → ${ts(sub.current_period_end)}`);
        console.log(`    Cancel at end:  ${sub.cancel_at_period_end}`);
        if (sub.canceled_at) console.log(`    Canceled at:    ${ts(sub.canceled_at)}`);
        if (sub.cancel_at) console.log(`    Cancel at:      ${ts(sub.cancel_at)}`);
        if (sub.ended_at) console.log(`    Ended at:       ${ts(sub.ended_at)}`);
        if (sub.trial_end) console.log(`    Trial end:      ${ts(sub.trial_end)}`);
        if (sub.discount) console.log(`    Discount:       ${JSON.stringify(sub.discount.coupon)}`);
        if (sub.metadata && Object.keys(sub.metadata).length > 0) {
          console.log(`    Metadata:       ${JSON.stringify(sub.metadata)}`);
        }
      }
    } else {
      console.log('\n  SUBSCRIPTIONS: None');
    }

    // Fetch recent charges
    const charges = await get('/v1/charges', { customer: customer.id, limit: 20 });
    if (charges.data && charges.data.length > 0) {
      console.log(`\n  CHARGES (${charges.data.length} most recent):`);
      console.log(`  ${'ID'.padEnd(30)} ${'Amount'.padEnd(10)} ${'Status'.padEnd(12)} ${'Date'.padEnd(22)} Description`);
      for (const ch of charges.data) {
        const desc = ch.description || ch.statement_descriptor || '';
        console.log(`  ${ch.id.padEnd(30)} ${cents(ch.amount).padEnd(10)} ${ch.status.padEnd(12)} ${ts(ch.created).padEnd(22)} ${desc}`);
        if (ch.refunded) {
          console.log(`    ↳ REFUNDED: ${cents(ch.amount_refunded)}`);
        } else if (ch.amount_refunded > 0) {
          console.log(`    ↳ PARTIALLY REFUNDED: ${cents(ch.amount_refunded)}`);
        }
      }
    } else {
      console.log('\n  CHARGES: None');
    }

    // Fetch invoices
    const invoices = await get('/v1/invoices', { customer: customer.id, limit: 10 });
    if (invoices.data && invoices.data.length > 0) {
      console.log(`\n  INVOICES (${invoices.data.length} most recent):`);
      console.log(`  ${'ID'.padEnd(30)} ${'Amount'.padEnd(10)} ${'Status'.padEnd(12)} ${'Date'.padEnd(22)} Description`);
      for (const inv of invoices.data) {
        const desc = inv.description || inv.lines?.data?.[0]?.description || '';
        console.log(`  ${inv.id.padEnd(30)} ${cents(inv.amount_due).padEnd(10)} ${inv.status.padEnd(12)} ${ts(inv.created).padEnd(22)} ${desc}`);
      }
    }

    console.log('');
  }

  if (jsonOutput) {
    out(customers.data);
  }
}

/**
 * Get details for a specific subscription by ID.
 */
async function subscriptionDetails(subId) {
  if (!subId) die('Subscription ID required. Usage: node query.mjs subscription <sub_xxx>');

  const sub = await get(`/v1/subscriptions/${subId}`);
  if (jsonOutput) {
    out(sub);
    return;
  }

  console.log('═'.repeat(70));
  console.log(`SUBSCRIPTION: ${sub.id}`);
  console.log('═'.repeat(70));
  console.log(`  Status:         ${sub.status}`);
  console.log(`  Customer:       ${sub.customer}`);
  console.log(`  Created:        ${ts(sub.created)}`);
  console.log(`  Period:         ${ts(sub.current_period_start)} → ${ts(sub.current_period_end)}`);
  console.log(`  Cancel at end:  ${sub.cancel_at_period_end}`);
  if (sub.canceled_at) console.log(`  Canceled at:    ${ts(sub.canceled_at)}`);
  if (sub.cancel_at) console.log(`  Cancel at:      ${ts(sub.cancel_at)}`);
  if (sub.ended_at) console.log(`  Ended at:       ${ts(sub.ended_at)}`);
  if (sub.trial_end) console.log(`  Trial end:      ${ts(sub.trial_end)}`);

  if (sub.items?.data) {
    console.log('\n  LINE ITEMS:');
    for (const item of sub.items.data) {
      console.log(`    ${item.id}: ${item.price.id} (${cents(item.price.unit_amount)}/${item.price.recurring?.interval || 'one-time'})`);
    }
  }

  if (sub.metadata && Object.keys(sub.metadata).length > 0) {
    console.log(`\n  Metadata: ${JSON.stringify(sub.metadata, null, 4)}`);
  }
}

/**
 * Cancel a subscription immediately (not at period end).
 */
async function cancelSubscription(subId, { atPeriodEnd = false } = {}) {
  if (!subId) die('Subscription ID required. Usage: node query.mjs cancel <sub_xxx> [--at-period-end]');

  if (atPeriodEnd) {
    // Update to cancel at period end
    const sub = await post(`/v1/subscriptions/${subId}`, { cancel_at_period_end: true });
    console.log(`Subscription ${sub.id} set to cancel at period end: ${ts(sub.current_period_end)}`);
    console.log(`  Status: ${sub.status}`);
    console.log(`  Cancel at period end: ${sub.cancel_at_period_end}`);
    if (jsonOutput) out(sub);
  } else {
    // Cancel immediately
    const sub = await del(`/v1/subscriptions/${subId}`);
    console.log(`Subscription ${sub.id} CANCELED IMMEDIATELY`);
    console.log(`  Status: ${sub.status}`);
    console.log(`  Canceled at: ${ts(sub.canceled_at)}`);
    console.log(`  Ended at: ${ts(sub.ended_at)}`);
    if (jsonOutput) out(sub);
  }
}

/**
 * List charges for a customer (by customer ID or email).
 */
async function listCharges(identifier, { limit = 20 } = {}) {
  if (!identifier) die('Customer ID or email required. Usage: node query.mjs charges <cus_xxx|email>');

  let customerId = identifier;
  if (!identifier.startsWith('cus_')) {
    // Look up by email
    const customers = await get('/v1/customers', { email: identifier, limit: 1 });
    if (!customers.data?.length) die(`No customer found for email: ${identifier}`);
    customerId = customers.data[0].id;
  }

  const charges = await get('/v1/charges', { customer: customerId, limit });

  if (jsonOutput) {
    out(charges.data);
    return;
  }

  if (!charges.data?.length) {
    console.log('No charges found.');
    return;
  }

  console.log(`CHARGES for ${customerId} (${charges.data.length} results):`);
  console.log('─'.repeat(110));
  console.log(`${'ID'.padEnd(30)} ${'Amount'.padEnd(10)} ${'Status'.padEnd(12)} ${'Refunded'.padEnd(12)} ${'Date'.padEnd(22)} Description`);
  console.log('─'.repeat(110));
  for (const ch of charges.data) {
    const desc = ch.description || ch.statement_descriptor || '';
    const refundStatus = ch.refunded ? `FULL (${cents(ch.amount_refunded)})` : ch.amount_refunded > 0 ? `PARTIAL (${cents(ch.amount_refunded)})` : 'No';
    console.log(`${ch.id.padEnd(30)} ${cents(ch.amount).padEnd(10)} ${ch.status.padEnd(12)} ${refundStatus.padEnd(12)} ${ts(ch.created).padEnd(22)} ${desc}`);
  }
}

/**
 * Refund a specific charge (full or partial).
 */
async function refundCharge(chargeId, { amount, reason } = {}) {
  if (!chargeId) die('Charge ID required. Usage: node query.mjs refund <ch_xxx> [--amount <cents>] [--reason <duplicate|fraudulent|requested_by_customer>]');

  const params = { charge: chargeId };
  if (amount) params.amount = amount;
  if (reason) params.reason = reason;

  const refund = await post('/v1/refunds', params);

  console.log(`REFUND CREATED: ${refund.id}`);
  console.log(`  Charge:   ${refund.charge}`);
  console.log(`  Amount:   ${cents(refund.amount)}`);
  console.log(`  Status:   ${refund.status}`);
  console.log(`  Reason:   ${refund.reason || 'N/A'}`);
  console.log(`  Created:  ${ts(refund.created)}`);

  if (jsonOutput) out(refund);
}

/**
 * Refund all charges for a customer.
 * Only refunds succeeded, non-refunded charges.
 */
async function refundAll(identifier, { reason, dryRun = false } = {}) {
  if (!identifier) die('Customer ID or email required. Usage: node query.mjs refund-all <cus_xxx|email> [--reason <reason>] [--dry-run]');

  let customerId = identifier;
  if (!identifier.startsWith('cus_')) {
    const customers = await get('/v1/customers', { email: identifier, limit: 1 });
    if (!customers.data?.length) die(`No customer found for email: ${identifier}`);
    customerId = customers.data[0].id;
  }

  // Fetch all charges (paginate)
  let hasMore = true;
  let startingAfter = null;
  const refundable = [];

  while (hasMore) {
    const params = { customer: customerId, limit: 100 };
    if (startingAfter) params.starting_after = startingAfter;
    const charges = await get('/v1/charges', params);

    for (const ch of charges.data) {
      if (ch.status === 'succeeded' && !ch.refunded && ch.amount > ch.amount_refunded) {
        refundable.push(ch);
      }
    }

    hasMore = charges.has_more;
    if (charges.data.length > 0) {
      startingAfter = charges.data[charges.data.length - 1].id;
    }
  }

  if (refundable.length === 0) {
    console.log('No refundable charges found.');
    return;
  }

  const totalRefundable = refundable.reduce((sum, ch) => sum + (ch.amount - ch.amount_refunded), 0);

  console.log(`Found ${refundable.length} refundable charge(s) totaling ${cents(totalRefundable)}`);
  console.log('─'.repeat(80));

  for (const ch of refundable) {
    const refundAmount = ch.amount - ch.amount_refunded;
    console.log(`  ${ch.id}  ${cents(refundAmount).padEnd(10)}  ${ts(ch.created)}  ${ch.description || ''}`);
  }

  if (dryRun) {
    console.log('\n[DRY RUN] No refunds issued. Remove --dry-run to execute.');
    return;
  }

  console.log('\nProcessing refunds...');
  const results = [];
  for (const ch of refundable) {
    try {
      const params = { charge: ch.id };
      if (reason) params.reason = reason;
      const refund = await post('/v1/refunds', params);
      console.log(`  ✓ ${ch.id} → ${refund.id} (${cents(refund.amount)})`);
      results.push({ charge: ch.id, refund: refund.id, amount: refund.amount, status: 'success' });
    } catch (err) {
      console.log(`  ✗ ${ch.id} → FAILED: ${err.message}`);
      results.push({ charge: ch.id, error: err.message, status: 'failed' });
    }
  }

  const succeeded = results.filter(r => r.status === 'success');
  const failed = results.filter(r => r.status === 'failed');
  console.log(`\nDone: ${succeeded.length} refunded, ${failed.length} failed`);

  if (jsonOutput) out(results);
}

/**
 * List payment methods for a customer.
 */
async function listPaymentMethods(identifier) {
  if (!identifier) die('Customer ID or email required. Usage: node query.mjs payment-methods <cus_xxx|email>');

  let customerId = identifier;
  if (!identifier.startsWith('cus_')) {
    const customers = await get('/v1/customers', { email: identifier, limit: 1 });
    if (!customers.data?.length) die(`No customer found for email: ${identifier}`);
    customerId = customers.data[0].id;
  }

  const methods = await get('/v1/payment_methods', { customer: customerId, limit: 20 });

  if (jsonOutput) {
    out(methods.data);
    return;
  }

  if (!methods.data?.length) {
    console.log('No payment methods found.');
    return;
  }

  console.log(`PAYMENT METHODS for ${customerId}:`);
  for (const pm of methods.data) {
    console.log(`  ${pm.id}  ${pm.type}  ${pm.card ? `${pm.card.brand} ****${pm.card.last4} exp ${pm.card.exp_month}/${pm.card.exp_year}` : ''}`);
  }
}

/**
 * Search Stripe customers using the Search API.
 */
async function searchCustomers(query) {
  if (!query) die('Search query required. Usage: node query.mjs search <query>');

  const result = await get('/v1/customers/search', { query });

  if (jsonOutput) {
    out(result.data);
    return;
  }

  if (!result.data?.length) {
    console.log('No customers found.');
    return;
  }

  console.log(`Found ${result.data.length} customer(s):`);
  for (const c of result.data) {
    const subCount = c.subscriptions?.data?.length || '?';
    console.log(`  ${c.id}  ${(c.email || 'N/A').padEnd(35)}  ${(c.name || 'N/A').padEnd(25)}  subs: ${subCount}  created: ${ts(c.created)}`);
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function usage() {
  console.log(`
Stripe Support CLI

Usage: node query.mjs <command> [options]

Commands:
  customer <email>              Look up customer by email (subscriptions, charges, invoices)
  search <query>                Search customers (Stripe Search syntax)
  subscription <sub_xxx>        Get subscription details
  charges <cus_xxx|email>       List charges for a customer
  payment-methods <cus_xxx|email>  List payment methods
  cancel <sub_xxx>              Cancel subscription immediately
  cancel <sub_xxx> --at-period-end  Cancel at end of billing period
  refund <ch_xxx>               Refund a charge (full)
  refund <ch_xxx> --amount <cents>  Partial refund
  refund-all <cus_xxx|email>    Refund ALL charges for a customer
  refund-all <cus_xxx|email> --dry-run  Preview what would be refunded

Global Flags:
  --json                        Output raw JSON

Examples:
  node query.mjs customer user@example.com
  node query.mjs cancel sub_1ABC123
  node query.mjs refund ch_1ABC123 --reason requested_by_customer
  node query.mjs refund-all user@example.com --dry-run
  node query.mjs search "email:'user@example.com'"
`);
}

async function main() {
  const args = process.argv.slice(2);

  // Extract global flags
  if (args.includes('--json')) {
    jsonOutput = true;
    args.splice(args.indexOf('--json'), 1);
  }

  const command = args[0];
  const positional = args[1];

  // Parse named flags
  const flags = {};
  for (let i = 2; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      // Boolean flags
      if (['dry-run', 'at-period-end'].includes(key)) {
        flags[key] = true;
      } else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        flags[key] = args[++i];
      } else {
        flags[key] = true;
      }
    }
  }

  switch (command) {
    case 'customer':
      await customerLookup(positional);
      break;
    case 'search':
      await searchCustomers(args.slice(1).join(' '));
      break;
    case 'subscription':
    case 'sub':
      await subscriptionDetails(positional);
      break;
    case 'charges':
      await listCharges(positional, { limit: flags.limit ? parseInt(flags.limit) : 20 });
      break;
    case 'payment-methods':
    case 'pm':
      await listPaymentMethods(positional);
      break;
    case 'cancel':
      await cancelSubscription(positional, { atPeriodEnd: !!flags['at-period-end'] });
      break;
    case 'refund':
      await refundCharge(positional, {
        amount: flags.amount ? parseInt(flags.amount) : undefined,
        reason: flags.reason,
      });
      break;
    case 'refund-all':
      await refundAll(positional, {
        reason: flags.reason,
        dryRun: !!flags['dry-run'],
      });
      break;
    default:
      usage();
      break;
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
