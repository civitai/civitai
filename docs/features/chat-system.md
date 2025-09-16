# Chat & Direct Messaging System

This document explains how the chat and direct messaging system works in Civitai. The chat system allows users to communicate privately through real-time messaging with rich features like link previews, typing indicators, and moderation controls.

## Architecture Overview

The chat system consists of several key components:

- **Chat Service**: Core business logic for creating chats and messages
- **Real-time Messaging**: WebSocket-based real-time updates via Signals
- **Chat UI Components**: React components for chat interface
- **Moderation Features**: User blocking, muting, and admin controls
- **Rich Content**: Link previews, embeds, and media support

## Database Schema

### Core Tables

#### `Chat`
- `id`: Unique chat identifier
- `hash`: Hash of participant user IDs for deduplication
- `ownerId`: User who created the chat
- `createdAt`: When chat was created

#### `ChatMember`
- `id`: Unique member identifier
- `chatId`: Reference to chat
- `userId`: Reference to user
- `isOwner`: Whether user owns the chat
- `isMuted`: Whether user is muted in chat
- `status`: Member status (Invited, Joined, Ignored, Left, Kicked)
- `lastViewedMessageId`: Last message user has seen
- `joinedAt`, `leftAt`, `kickedAt`: Timestamps for status changes

#### `ChatMessage`
- `id`: Unique message identifier
- `chatId`: Reference to chat
- `userId`: Message author (-1 for system messages)
- `content`: Message content
- `contentType`: Type of content (Markdown, Image, Video, Audio, Embed), only markdown and embed primarily used
- `referenceMessageId`: Optional reference to another message
- `createdAt`: When message was sent

## Core Services

### Chat Service (`src/server/services/chat.service.ts`)

#### Key Functions

##### `upsertChat()`
Creates or retrieves existing chat between users:
- Checks for blocked users and filters them out
- Enforces rate limits (max 1000 chats, 10 per day)
- Uses hash-based deduplication to prevent duplicate chats
- Automatically adds users to WebSocket groups for real-time updates
- Sends signals when new chat rooms are created

##### `createMessage()`
Creates new messages in chats:
- Validates user permissions and chat membership
- Handles message references (replies)
- Processes link previews automatically using `unfurl.js`
- Supports special Civitai link handling (`civitai://` protocol)
- Creates embed messages for links with metadata
- Sends real-time signals to chat participants

## Client-Side Implementation

### Key Components

#### ChatWindow (`src/components/Chat/ChatWindow.tsx`)
- Main chat interface container
- Responsive layout: mobile (single pane) vs desktop (dual pane)
- Left pane: Chat list and search
- Right pane: Active chat or new chat creation

#### ChatList (`src/components/Chat/ChatList.tsx`)
- Displays user's chat conversations
- Shows latest message preview
- Unread message indicators
- Search functionality

#### ExistingChat (`src/components/Chat/ExistingChat.tsx`)
- Active chat conversation view
- Message history with infinite scroll
- Message composition and sending
- Typing indicators
- User management (invite, kick, mute)

#### NewChat (`src/components/Chat/NewChat.tsx`)
- Interface for creating new chats
- User search and selection
- Chat creation workflow

## Rich Content Features

### Link Processing
The chat system automatically processes links in messages:

1. **Civitai Links**: Special handling for internal links using `civitai://` protocol
2. **External Links**: Automatic unfurling with metadata extraction
3. **Image Links**: Direct image embedding for image URLs
4. **Link Validation**: Whitelist/blacklist validation before processing

### Link Utilities (`src/components/Chat/util.tsx`)
```typescript
export const linkifyOptions: Opts = {
  render: renderLink,      // Custom link rendering
  validate: validateLink,  // Link validation rules
};
```

Supported link patterns:
- `civitai://models/{id}/{versionId}` - Internal model links
- Standard HTTP/HTTPS URLs
- Image URLs for inline display

### Embed Messages
- Automatically generated for links with metadata
- System-generated (userId: -1) 
- Reference original message
- Include title, description, and thumbnail

## User Settings

Users can configure chat preferences:

```typescript
type UserSettingsChat = {
  muteSounds?: boolean;    // Disable notification sounds
  acknowledged?: boolean;  // Has acknowledged chat feature
};
```

## Moderation Features

### User Blocking
- Blocked users are filtered from chat creation
- Prevents messages between blocked users
- Moderators can bypass blocking restrictions

### Chat Member Management
- **Muting**: Prevents user from sending messages (except to moderators)
- **Kicking**: Removes user from chat
- **Status Management**: Control member participation level

### Moderator Privileges
- Can chat with muted users
- Bypass rate limits and blocking
- Automatically join chats they create
- Enhanced permissions for user management

## API Endpoints

### tRPC Routes (`src/server/routers/chat.router.ts`)

```typescript
export const chatRouter = router({
  getUserSettings: protectedProcedure,        // Get user chat preferences
  setUserSettings: protectedProcedure,        // Update chat preferences
  getAllByUser: protectedProcedure,           // Get user's chat list
  createChat: guardedProcedure,               // Create new chat
  modifyUser: protectedProcedure,             // Manage chat members
  markAllAsRead: protectedProcedure,          // Mark messages as read
  getInfiniteMessages: protectedProcedure,    // Get chat messages (paginated)
  getMessageById: protectedProcedure,         // Get specific message
  createMessage: protectedProcedure,          // Send message
  isTyping: protectedProcedure,               // Send typing indicator
  getUnreadCount: protectedProcedure,         // Get unread message counts
});
```

## Development Guidelines

### Adding New Message Types
1. Add to `ChatMessageType` enum
2. Update message rendering logic
3. Add content validation
4. Handle real-time updates
5. Update mobile/desktop UI
