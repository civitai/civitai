# Notifications System

This document explains how the notification system works in Civitai. The notification service itself runs in a separate repository, but this codebase handles the client-side implementation, notification processing, and user interaction.

## Key Files

| File | Purpose |
|------|---------|
| `src/server/notifications/` | Notification processors by feature |
| `src/server/notifications/base.notifications.ts` | `createNotificationProcessor()` factory |
| `src/server/notifications/utils.notifications.ts` | Processor registry |
| `src/server/services/notification.service.ts` | `createNotification()` service |
| `src/server/jobs/send-notifications.ts` | Background processing job |
| `src/components/Notifications/` | Client-side notification components |

## Architecture Overview

The notification system consists of several key components:

- **Notification Processors**: Define different types of notifications and their behavior
- **Notification Service**: Handles creation, retrieval, and management of notifications
- **Client Components**: UI components for displaying and interacting with notifications
- **Real-time Updates**: WebSocket-based real-time notification delivery via Signals
- **Caching Layer**: Redis-based caching for notification counts and data

## Database Schema

### Core Tables
- `Notification`: Stores notification content and metadata
- `UserNotification`: Links notifications to users with read/unread status
- `PendingNotification`: Queue for notifications to be processed
- `UserNotificationSettings`: User preferences for notification types

### Key Fields
- `type`: Notification type (e.g., 'model-download-milestone', 'comment-created')
- `category`: Notification category for grouping (Comment, Update, Milestone, etc.)
- `details`: JSON object containing notification-specific data
- `key`: Unique identifier for deduplication

## Notification Categories

Located in `src/server/common/enums.ts`:

```typescript
enum NotificationCategory {
  Comment = 'Comment',
  Update = 'Update', 
  Milestone = 'Milestone',
  Bounty = 'Bounty',
  Buzz = 'Buzz',
  Creator = 'Creator',
  System = 'System',
  Other = 'Other',
}
```

## Notification Types & Processors

Notification processors are defined in `src/server/notifications/` and handle:
- Query preparation for finding relevant events
- Message formatting for display
- Category assignment and settings

### Key Processor Files
- `model.notifications.ts` - Model-related notifications (downloads, likes, milestones)
- `comment.notifications.ts` - Comment notifications
- `reaction.notifications.ts` - Like/reaction notifications  
- `follow.notifications.ts` - User follow notifications
- `bounty.notifications.ts` - Bounty-related notifications
- `buzz.notifications.ts` - Buzz transaction notifications
- And many more...

Important note: I've marked where these can moved as "Moveable" creation as opposed to job-based. The only notifications that should really be handled in jobs are ones that are time-based, such as milestones or hourly/daily aggregations. The rest should eventually be moved to on-demand creation.

Notifications can be manually created via `createNotification()` in `notification.service.ts`:

## Client-Side Implementation

### Key Components

#### NotificationBell (`src/components/Notifications/NotificationBell.tsx`)
- Shows notification count indicator
- Opens notification drawer on click
- Hides on notification pages

#### NotificationDrawer (`src/components/Notifications/NotificationsDrawer.tsx`)
- Displays notification list in a drawer
- Handles infinite scrolling
- Category filtering

#### NotificationList (`src/components/Notifications/NotificationList.tsx`)
- Renders individual notifications
- Mark as read functionality
- Pagination support

## User Settings

Users can control notification preferences in `src/components/Account/NotificationsCard.tsx`:

- Toggle specific notification types on/off
- Settings stored in `UserNotificationSettings` table
- Respected during notification creation

## Caching Strategy

Notification counts are cached in Redis via `notification-cache.ts`:

- User-level caching of unread counts by category
- Cache invalidation on read/creation
- Optimistic updates for UI responsiveness

## API Endpoints

### tRPC Routes (`src/server/routers/notification.router.ts`)
- `getAllByUser` - Get paginated user notifications
- `markRead` - Mark notifications as read
- `getCount` - Get notification counts (cached)

### Best Practices

- **Deduplication**: Use unique keys to prevent duplicate notifications
- **User Preferences**: Respect user notification settings
- **Performance**: Optimize queries for large datasets
- **Real-time**: Emit signals for immediate UI updates
- **Categories**: Group related notifications logically

## Debugging

### Common Issues
- **Missing Notifications**: Check user settings and deduplication logic
- **Duplicate Notifications**: Verify unique key generation
- **Performance**: Monitor notification job execution times
- **Cache Issues**: Clear Redis cache if counts seem incorrect
