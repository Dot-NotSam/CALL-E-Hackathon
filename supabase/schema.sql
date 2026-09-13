-- Supabase Schema for Sentinel Ops (v2.0 Wholesale Coordination Agent)
-- Created for CALL-E Hackathon

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Organizations (WHOLESALER | DISTRIBUTOR)
CREATE TABLE IF NOT EXISTS public.organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('WHOLESALER', 'DISTRIBUTOR')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. User Profiles (Linked to auth.users for RBAC)
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('ADMIN', 'DISTRIBUTOR', 'WHOLESALER')),
    organization_id TEXT REFERENCES public.organizations(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Consented Contacts
CREATE TABLE IF NOT EXISTS public.contacts (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    phone_e164 TEXT NOT NULL,
    product_categories TEXT[] DEFAULT '{}',
    region TEXT NOT NULL,
    working_hours JSONB NOT NULL DEFAULT '{"start": "09:00", "end": "18:00", "timezone": "Asia/Kolkata"}'::jsonb,
    escalation_priority INT NOT NULL DEFAULT 1,
    preferred_language TEXT NOT NULL DEFAULT 'en-IN',
    consent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cooldown_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Orders (Coordination Requests)
CREATE TABLE IF NOT EXISTS public.orders (
    id TEXT PRIMARY KEY,                       -- System ID e.g. CR-1007
    reference TEXT NOT NULL,                  -- Business Order Reference e.g. ORD-482
    trace_id TEXT NOT NULL,
    buyer_id TEXT NOT NULL REFERENCES public.organizations(id),
    seller_id TEXT NOT NULL REFERENCES public.organizations(id),
    status TEXT NOT NULL DEFAULT 'AWAITING_CONFIRMATION' CHECK (
        status IN (
            'AWAITING_CONFIRMATION',
            'CALLING',
            'CONFIRMED',
            'PARTIALLY_CONFIRMED',
            'APPROVAL_REQUIRED',
            'CALLBACK_SCHEDULED',
            'HUMAN_REVIEW',
            'UNRESOLVED',
            'SUPPRESSED'
        )
    ),
    urgency TEXT NOT NULL DEFAULT 'PRIORITY' CHECK (urgency IN ('ROUTINE', 'PRIORITY', 'URGENT')),
    required_by TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    closed_at TIMESTAMPTZ,
    current_rung INT NOT NULL DEFAULT 1,
    max_rungs INT NOT NULL DEFAULT 3,
    outcome TEXT,
    operator_minutes_saved INT,
    scenario_id TEXT DEFAULT 'hero-replenishment'
);

-- 5. Order Items
CREATE TABLE IF NOT EXISTS public.order_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id TEXT NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
    sku TEXT NOT NULL,
    description TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT 'cases',
    requested_quantity INT NOT NULL,
    confirmed_quantity INT,
    remaining_quantity INT,
    unit_price NUMERIC(10, 2) NOT NULL,
    currency TEXT NOT NULL DEFAULT 'INR',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Triggers / Signals
CREATE TABLE IF NOT EXISTS public.triggers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id TEXT NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('ORDER', 'INVENTORY', 'DELIVERY', 'EXCEPTION', 'IOT')),
    summary TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    raw_payload JSONB
);

-- 7. Scheduled Follow-ups
CREATE TABLE IF NOT EXISTS public.follow_ups (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('VERIFICATION', 'CALLBACK', 'REMAINING_QUANTITY')),
    due_at TIMESTAMPTZ NOT NULL,
    contact_id TEXT NOT NULL REFERENCES public.contacts(id),
    note TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED', 'DONE', 'CANCELLED')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. Call Records & Plans
CREATE TABLE IF NOT EXISTS public.calls (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
    contact_id TEXT REFERENCES public.contacts(id),
    calle_call_id TEXT,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (
        status IN (
            'queued', 'dialling', 'connected', 'in_conversation',
            'extracting', 'completed', 'failed', 'no_answer'
        )
    ),
    confidence_score NUMERIC(3, 2),
    confidence_label TEXT,
    evidence JSONB DEFAULT '[]'::jsonb,
    structured_result JSONB,
    transcript TEXT,
    trace_id TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 9. Agent Event Log (For SSE Event Replay)
CREATE TABLE IF NOT EXISTS public.agent_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id TEXT NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    payload JSONB NOT NULL,
    trace_id TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 10. System Settings (Kill Switch, System State)
CREATE TABLE IF NOT EXISTS public.system_settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert initial Kill Switch setting
INSERT INTO public.system_settings (key, value)
VALUES ('killswitch', '{"engaged": false}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Automatic Profile Creation Trigger on Signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, email, full_name, role, organization_id)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
        COALESCE(NEW.raw_user_meta_data->>'role', 'DISTRIBUTOR'),
        COALESCE(NEW.raw_user_meta_data->>'organization_id', 'org-northgate')
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Indices for performance
CREATE INDEX IF NOT EXISTS idx_orders_reference ON public.orders(reference);
CREATE INDEX IF NOT EXISTS idx_orders_status ON public.orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_buyer ON public.orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_orders_seller ON public.orders(seller_id);
CREATE INDEX IF NOT EXISTS idx_agent_events_order ON public.agent_events(order_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_follow_ups_due ON public.follow_ups(due_at, status);
