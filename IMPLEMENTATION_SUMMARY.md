# Authentication & Abandoned Carts Implementation

## What's been implemented

### 1. **Application-Wide Authentication** ✅
- **Protected dashboard**: All API routes except webhooks now require authentication
- **Login page**: New login screen with username/password (already existed, now integrated)
- **Session management**: Secure cookie-based sessions (7-day TTL)
- **Logout**: Users can now log out from the sidebar
- **Webhook security**: Shopify webhooks (`/api/webhook/shopify`) remain public & unprotected
- **OAuth flows**: Shopify OAuth endpoints remain public for store connection

### 2. **Abandoned Cart Tracking** ✅
- **Automatic capture**: When `checkouts/create` webhooks arrive, abandoned carts are automatically tracked
- **Database table**: New `abandoned_carts` table with full checkout data (customer, items, total, URL)
- **Abandoned Carts page**: New dashboard page showing:
  - Stats: Active abandoned, recovered, total tracked, potential revenue
  - List of abandoned carts with customer info, value, items count
  - Detail modal showing full cart contents, customer contact info, and checkout link
  - Mark as recovered action to track recovery
  - Filter between active and recovered carts

### 3. **New API Endpoints** ✅
```
GET  /api/abandoned-carts              - List abandoned carts (requires auth)
GET  /api/abandoned-carts/stats        - Cart statistics (requires auth)
GET  /api/abandoned-carts/:id          - Get cart details (requires auth)
POST /api/abandoned-carts/:id/recover  - Mark cart as recovered (requires auth)
```

All dashboard API routes are now protected. Public endpoints for webhooks remain intact.

## Setup Instructions

### 1. Enable Authentication (Optional but Recommended)

Edit `.env` and set your credentials:
```bash
APP_USERNAME=admin
APP_PASSWORD=your-secure-password
```

**Important**: 
- Leave `APP_PASSWORD` empty to disable authentication (open dashboard)
- Once set, the entire dashboard requires login
- Webhooks and OAuth remain public/unprotected

### 2. Deploy

```bash
# Install all dependencies
npm run install:all

# Build client
npm run build:client

# Start server (in production)
npm run start

# Or run with development server
npm run dev
```

### 3. First Login

1. Navigate to the dashboard
2. You'll see the login screen
3. Enter credentials from `.env` (default: `admin` / your password)
4. Dashboard unlocks for the session

## What Changed

### Backend (server/)
- ✅ Added auth middleware in `index.js` (lines 72-89)
- ✅ Added abandoned cart endpoints (lines 202-237)
- ✅ Added webhook capture logic for `checkouts/create` (lines 489-515)
- ✅ Added `saveAbandonedCart`, `getAbandonedCarts`, `updateAbandonedCartStatus`, `getAbandonedCartStats` functions to `db.js`
- ✅ Created `abandoned_carts` table in database schema
- ✅ Updated `.env.example` with auth variables

### Frontend (client/src/)
- ✅ Created `components/AbandonedCarts.tsx` (new page component)
- ✅ Updated `App.tsx` to:
  - Import AbandonedCarts component
  - Add "Abandoned Carts" to navigation
  - Check auth status on app load
  - Show Login page if auth required
  - Show logout button in sidebar
  - Route to abandoned carts page

## Security Notes

- ✅ **Webhooks remain public**: `POST /api/webhook/shopify` is not protected (by design)
- ✅ **OAuth flow public**: `GET /api/shopify/auth/callback` is not protected (required for OAuth)
- ✅ **Dashboard protected**: All dashboard data endpoints require authentication
- ✅ **Session security**: Cookies are HttpOnly, SameSite, and Secure in production
- ✅ **Timing-safe comparison**: Password comparison uses `crypto.timingSafeEqual()`

## What's NOT Protected (By Design)

These endpoints remain public for system integration:
- `POST /api/webhook/shopify` - Shopify webhooks
- `GET /api/shopify/auth/callback` - OAuth callback
- `GET /api/auth/login` - Login endpoint
- `GET /api/auth/me` - Auth status check

## Database Changes

### New Table: `abandoned_carts`
```sql
CREATE TABLE abandoned_carts (
  id TEXT PRIMARY KEY,
  checkout_token TEXT UNIQUE NOT NULL,
  customer_name TEXT,
  customer_email TEXT,
  customer_phone TEXT,
  cart_items TEXT NOT NULL DEFAULT '[]',  -- JSON array
  cart_total_price TEXT,
  abandoned_at TEXT NOT NULL,
  recovered_at TEXT,
  status TEXT NOT NULL DEFAULT 'abandoned',
  shopify_checkout_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### Indexes
- `idx_abandoned_carts_status` on (status, abandoned_at)
- `idx_abandoned_carts_token` on (checkout_token)

## Testing

### Test Webhook Capture
1. Use the Test Console to send a `checkouts/create` webhook
2. Go to "Abandoned Carts" page
3. New cart should appear in the list

### Test Authentication
1. Set `APP_PASSWORD` in `.env`
2. Restart server
3. Refresh dashboard → you'll see login screen
4. Login with credentials
5. Click logout to test session clearing

### Test Cart Recovery
1. Click on an abandoned cart in the list
2. View cart details in the modal
3. Click "Mark as Recovered"
4. Switch to "Recovered" filter to see it moved

## Configuration

### Environment Variables
```bash
# Required
INSFORGE_DATABASE_URL=postgresql://...

# Auth (optional)
APP_USERNAME=admin              # default: admin
APP_PASSWORD=                   # required to enable auth; leave empty to disable

# Shopify & Chatwoot (existing)
# ... other variables from .env
```

## Future Enhancements

- Add email/SMS recovery campaigns for abandoned carts
- Integrate with Shopify's recovery emails
- Add recovery rate analytics
- Schedule automatic recovery messages via flows
- Add cart recovery discounts tracking
