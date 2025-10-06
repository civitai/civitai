# ZKP2P Headless Example

A headless, iframe-embeddable implementation of the ZKP2P onramp flow for purchasing digital assets with fiat currency through peer-to-peer exchange.

## Overview

This application provides a streamlined interface for users to:
1. Exchange fiat currency (USD) for digital dollars (USDC) via ZKP2P's peer-to-peer exchange
2. Automatically convert digital dollars to platform-specific tokens (e.g., Buzz)

The entire flow is designed to be embedded as an iframe within your platform, providing a seamless user experience while clearly maintaining ZKP2P branding and terms.

## iframe Integration

### Basic Implementation

Embed the onramp flow in your website using an iframe:

```html
<iframe
  src="https://zkp2p.civitai.com/onramp?usdcAmount=5&currency=usd&paymentMethod=venmo"
  width="100%"
  height="600"
  frameborder="0"
  allow="clipboard-write"
></iframe>
```

### URL Parameters

The onramp flow accepts the following URL parameters:

| Parameter | Required | Description | Example |
|-----------|----------|-------------|---------|
| `usdcAmount` | Yes | Amount of USDC to purchase | `5`, `10.50` |
| `currency` | Yes | Fiat currency code | `usd` |
| `paymentMethod` | Yes | Payment platform (see supported methods below) | `venmo`, `paypal`, `cashapp` |
| `explain` | No | Show explanation screen | `true` (omit for false) |

### Supported Payment Methods

| Payment Method | Value | Features | Notes |
|----------------|-------|----------|-------|
| **Venmo** | `venmo` | ✅ Pre-filled amount<br>✅ Pre-filled notes | Most seamless experience |
| **CashApp** | `cashapp` | ✅ Pre-filled amount<br>❌ No pre-filled notes | Notes must be added manually |
| **PayPal** | `paypal` | ✅ Pre-filled amount<br>❌ No pre-filled notes | Must send as "Friends and Family" from personal account |
| **Zelle** | `zelle` | ❌ Manual amount entry<br>❌ Manual recipient entry | Chase, Citi, or Bank of America only |
| **Wise** | `wise` | ❌ Manual amount entry<br>❌ Manual recipient entry | International transfers supported |
| **Revolut** | `revolut` | ❌ Manual amount entry<br>❌ Manual recipient entry | European users preferred |

### Example URLs

```
# Venmo (most seamless - pre-fills amount and notes)
/onramp?usdcAmount=10&currency=usd&paymentMethod=venmo

# PayPal with explanation screen
/onramp?explain=true&usdcAmount=5&currency=usd&paymentMethod=paypal

# CashApp (pre-fills amount only)
/onramp?usdcAmount=20&currency=usd&paymentMethod=cashapp

# Zelle (manual entry required)
/onramp?usdcAmount=15&currency=usd&paymentMethod=zelle

# Wise for international transfers
/onramp?usdcAmount=50&currency=usd&paymentMethod=wise

# Revolut for European users
/onramp?usdcAmount=25&currency=usd&paymentMethod=revolut
```

### Parent Window Communication (Optional)

The iframe can communicate status updates to the parent window via postMessage:

```javascript
// Listen for status updates in parent window
window.addEventListener('message', (event) => {
  // Verify the message source
  if (event.origin !== 'https://zkp2p.civitai.com') return;

  // Messages follow this format
  if (event.data?.source === 'zkp2p-onramp' && event.data?.event) {
    const eventType = event.data.event;
    const eventData = event.data.data;

    switch(eventType) {
      case 'flow:started':
        // Flow initialized
        console.log('User started the flow');
        break;

      case 'flow:step':
        // User reached a specific step
        console.log('User reached step:', eventData.step);
        // Possible steps:
        // - 'checking-intent': Setting up exchange
        // - 'payment': Showing payment details
        // - 'authenticating': Checking transactions
        // - 'selecting': User selecting transaction
        // - 'verifying': Generating proof
        // - 'success': USDC received
        // - 'canceling': Canceling transaction
        // - 'canceled': Transaction canceled
        // - 'purchase': Purchasing Buzz
        // - 'purchase-success': Buzz received
        break;

      case 'flow:completed':
        // Entire flow completed successfully
        console.log('Flow completed successfully');
        break;

      case 'flow:error':
        // Error occurred during flow
        console.error('Flow error:', eventData.message);
        break;

      case 'flow:return-home':
        // User clicked "Go Home" button
        console.log('User wants to return home');
        // Handle navigation as needed
        break;
    }
  }
});
```

### Security Configuration

For proper iframe embedding on civitai.com:

1. **Content Security Policy (CSP)**: The ZKP2P service at `zkp2p.civitai.com` should include:
   ```
   Content-Security-Policy: frame-ancestors 'self' https://civitai.com https://*.civitai.com;
   ```

2. **CORS Headers**: API endpoints should accept requests from:
   - `https://civitai.com`
   - `https://*.civitai.com`

3. **Cookie Settings**: Authentication cookies should use:
   - `SameSite=None; Secure` for cross-origin iframe compatibility
   - Domain set to `.civitai.com` for subdomain sharing

## User Flow

### Step 1: Explanation (Optional)
If `?explain=true` is included, users see:
- Clear explanation of the two-step transaction process
- Consent checkboxes for understanding and auto-purchase
- ZKP2P branding and legal links

### Step 2: Extension Check
Automatically checks for PeerAuth browser extension:
- Detects compatible browsers (Chrome, Brave, Edge)
- Provides installation instructions if needed
- Skips if extension is already installed

### Step 3: ZKP2P Exchange
Unified exchange experience:
1. **Payment Instructions** - Display payment details and QR code
2. **Transaction Verification** - Automatic PeerAuth authentication
3. **Transaction Selection** - User confirms their transaction
4. **Verification Progress** - Visual progress indicators
5. **Success Confirmation** - Digital dollars received

### Step 4: Token Purchase
Automatic conversion to platform tokens:
- Sends digital dollars to platform
- Monitors for token arrival via SSE
- Displays success with token amount

## Requirements

### Browser Requirements
- Chrome, Brave, or Edge browser
- PeerAuth extension installed
- JavaScript enabled
- Cookies enabled (for session management)

### Technical Requirements
- The iframe must be served over HTTPS
- Allow `clipboard-write` permission for QR code copying
- Minimum iframe dimensions: 400px width, 500px height
- Recommended: 100% width, 600px+ height

## Security & Compliance

- All transactions are processed through ZKP2P's verified peer-to-peer exchange
- Users must explicitly consent to the transaction process
- Clear ZKP2P branding maintained throughout the flow
- Links to ZKP2P [Terms of Service](https://www.zkp2p.xyz/tos) and [Privacy Policy](https://www.zkp2p.xyz/pp)

## Development

### Setup

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Run tests
npm test

# Build for production
npm run build
```

### Environment Variables

```env
# Required
NEXTAUTH_SECRET=your-secret-here
DATABASE_URL=your-database-url

# Optional
PUBLIC_CIVITAI_API_URL=https://api.civitai.com
``
