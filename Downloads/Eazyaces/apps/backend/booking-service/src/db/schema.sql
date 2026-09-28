ALTER TABLE provider_profiles
  ADD COLUMN IF NOT EXISTS base_price_paise BIGINT CHECK (base_price_paise IS NULL OR base_price_paise > 0);

CREATE TABLE IF NOT EXISTS bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES users(id),
  provider_id UUID NOT NULL REFERENCES provider_profiles(id),
  service_category TEXT NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  service_address TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'in_progress', 'completed', 'cancelled', 'rejected')),
  amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
  platform_fee_paise BIGINT NOT NULL DEFAULT 0 CHECK (platform_fee_paise >= 0),
  payment_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (payment_status IN ('pending', 'created', 'paid', 'failed', 'refund_pending', 'refunded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS bookings_customer_created_idx ON bookings (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bookings_provider_created_idx ON bookings (provider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bookings_provider_schedule_idx ON bookings (provider_id, scheduled_at, status);

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_payment_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_payment_status_check
  CHECK (payment_status IN ('pending', 'created', 'paid', 'failed', 'refund_pending', 'refunded', 'partially_refunded'));
ALTER TABLE payout_records ADD COLUMN IF NOT EXISTS booking_id UUID REFERENCES bookings(id);

CREATE TABLE IF NOT EXISTS payment_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id),
  razorpay_order_id TEXT NOT NULL UNIQUE,
  razorpay_payment_id TEXT UNIQUE,
  razorpay_event_id TEXT UNIQUE,
  amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
  status TEXT NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'pending', 'failed', 'paid', 'refund_pending', 'refunded', 'partially_refunded')),
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE payment_transactions DROP CONSTRAINT IF EXISTS payment_transactions_status_check;
ALTER TABLE payment_transactions ADD CONSTRAINT payment_transactions_status_check
  CHECK (status IN ('created', 'pending', 'failed', 'paid', 'refund_pending', 'refunded', 'partially_refunded'));

CREATE INDEX IF NOT EXISTS payment_transactions_booking_idx ON payment_transactions (booking_id, created_at DESC);

CREATE TABLE IF NOT EXISTS disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL UNIQUE REFERENCES bookings(id),
  raised_by UUID NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  outcome TEXT CHECK (outcome IN ('refund_customer', 'release_provider', 'partial', 'dismissed')),
  resolution_note TEXT,
  refund_amount_paise BIGINT CHECK (refund_amount_paise IS NULL OR refund_amount_paise >= 0),
  resolved_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS disputes_queue_idx ON disputes (status, created_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  reference_type TEXT,
  reference_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS notifications_user_unread_idx ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;

ALTER TABLE payout_records DROP CONSTRAINT IF EXISTS payout_records_status_check;
ALTER TABLE payout_records ADD CONSTRAINT payout_records_status_check
  CHECK (status IN ('requested', 'processing', 'completed', 'failed', 'rejected'));