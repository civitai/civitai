# Account Switching & Impersonation Documentation

## Overview
The Account Switching & Impersonation system allows users to manage multiple accounts and enables moderators to temporarily act as other users for support and moderation purposes. The system uses encrypted tokens for secure authentication and maintains session integrity through NextAuth.

## Architecture

### Two Distinct Features

#### 1. Account Switching (All Users)
- Allows users to link multiple authentication providers (Google, Discord, etc.)
- Quick switching between linked accounts without re-authentication
- Persisted account list in browser localStorage
- Automatic session management

#### 2. Impersonation (Moderators Only)
- Temporary ability to act as another user
- Feature-flag protected (`impersonation`)
- Activity tracking for audit purposes
- Visual indicators when impersonating
- Easy switch-back mechanism

### Authentication Flow

#### Token Generation & Encryption
Uses AES-256-CBC encryption for secure token generation:

```
// Token Structure (EncryptedDataSchema)
{
  iv: string,        // Initialization vector (base64)
  data: string,      // Encrypted user ID (base64)
  signedAt: string   // ISO timestamp
}
```

The encryption uses `NEXTAUTH_SECRET` as the key, ensuring tokens can only be decrypted by the same server.

### Database Schema

#### ModActivity Table (Audit Log)
Tracks all moderation activities including impersonation:
```
ModActivity {
  userId      Int       -- Moderator performing action
  entityType  String    -- Type of entity ('impersonate')
  activity    String    -- Action taken ('on' or 'off')
  entityId    Int       -- Target user ID
  createdAt   DateTime  -- When action occurred
}
```

## Implementation Details

### Backend Services

#### Token Service (`src/pages/api/auth/civ-token.ts`)
- **Purpose**: Generates encrypted tokens for current user
- **Security**: Protected endpoint requiring authentication
- **Usage**: Called when user logs in to generate switchable token

```
// Encryption process
1. Generate random 16-byte IV
2. Create AES-256-CBC cipher with server secret
3. Encrypt user ID
4. Return base64-encoded token with IV and timestamp
```

#### Impersonation Endpoint (`src/pages/api/auth/impersonate.ts`)
- **Access**: Moderators only with `impersonation` feature flag
- **Validation**:
  - Checks moderator permissions
  - Validates target user exists
  - Prevents self-impersonation
- **Audit**: Records activity in ModActivity table
- **Response**: Returns encrypted token for target user

#### NextAuth Configuration
Custom credentials provider for account switching:
```typescript
CredentialsProvider({
  id: 'account-switch',
  name: 'Account Switch',
  credentials: { iv, data, signedAt },
  authorize: async (credentials) => {
    // Decrypt token to get user ID
    // Fetch and return user session
  }
})
```

### Frontend Components

#### AccountProvider (`src/components/CivitaiWrapped/AccountProvider.tsx`)
Central context provider managing:
- **Account Storage**: localStorage with key `civitai-accounts`
- **Original Account**: Tracks moderator account during impersonation
- **Session Management**: Handles login/logout flows
- **Auto-reload**: Refreshes page when account changes

Key Methods:
- `swapAccount(token)`: Switch to different account
- `logout()`: Sign out current, switch to next if available
- `logoutAll()`: Clear all accounts and sign out
- `removeAccount(id)`: Remove specific account from list

#### ImpersonateButton (`src/components/Moderation/ImpersonateButton.tsx`)
- **Display**: Red glowing crystal ball icon in header
- **Visibility**: Only when actively impersonating
- **Tooltip**: Shows current and original account info
- **Action**: One-click return to original account

#### UserContextMenu (`src/components/Profile/UserContextMenu.tsx`)
Profile dropdown menu with moderation options:
- **Impersonate User**: Initiates impersonation flow
- **Visibility**: Only for moderators with feature flag
- **Feedback**: Loading notifications during switch

#### UserMenu (`src/components/AppLayout/AppHeader/UserMenu.tsx`)
Main user menu with account switcher:
- **Account List**: Shows all linked accounts
- **Active Indicator**: Green checkmark on current
- **Add Account**: Link additional providers
- **Logout Options**: Individual or all accounts

### Data Flow

#### Account Switching Flow
1. User authenticates with provider
2. System generates encrypted token
3. Token stored in localStorage with account info
4. User selects different account from menu
5. Frontend calls `signIn('account-switch', token)`
6. NextAuth validates and switches session
7. Page reloads with new user context

#### Impersonation Flow
1. Moderator clicks "Impersonate User" in profile menu
2. Frontend requests token from `/api/auth/impersonate`
3. Backend validates permissions and logs activity
4. Encrypted token returned to frontend
5. Original account info saved to localStorage
6. Account switch initiated with target token
7. Red indicator appears showing impersonation active
8. Moderator clicks indicator to return to original

## Implementation Patterns

### localStorage Structure
```
// civitai-accounts
{
  "123": {
    token: { iv, data, signedAt },
    active: true,
    email: "user@example.com",
    username: "username",
    avatarUrl: "https://..."
  },
  // Additional accounts...
}

// civitai-og-account (during impersonation)
{
  id: 456,
  username: "moderator_name"
}
```

## Error Handling

### Common Errors
- **Invalid Token**: Decryption failure returns error
- **User Not Found**: 404 when target doesn't exist
- **Unauthorized**: 401 when lacking permissions
- **Same User**: 400 when trying to self-impersonate

## Future Enhancements

Potential improvements to consider:
- Token expiration for enhanced security
- Impersonation reason requirement
- Time limits on impersonation sessions
- Enhanced audit logging (end times)
- Role-based impersonation restrictions
- Notification to impersonated users
- Read-only impersonation mode
