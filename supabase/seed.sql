-- Seed Data for Sentinel Ops (v2.0 Wholesale Coordination Agent)

-- 1. Organizations
INSERT INTO public.organizations (id, name, role) VALUES
('org-northgate', 'Northgate Distributors', 'DISTRIBUTOR'),
('org-metro', 'Metro Supply Co.', 'WHOLESALER'),
('org-apex', 'Apex Logistics & Pharma', 'WHOLESALER')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role;

-- 2. Consented Contacts for Metro Supply Co. (Seller)
INSERT INTO public.contacts (id, organization_id, name, role, phone_e164, product_categories, region, working_hours, escalation_priority, preferred_language, consent_at) VALUES
(
    'ct-rajesh-iyer',
    'org-metro',
    'Rajesh Iyer',
    'Dispatch Lead',
    '+919876543210',
    ARRAY['medical', 'pharma', 'cold-chain'],
    'West',
    '{"start": "08:00", "end": "19:00", "timezone": "Asia/Kolkata"}'::jsonb,
    1,
    'en-IN',
    '2026-09-01T10:00:00Z'
),
(
    'ct-sunita-patel',
    'org-metro',
    'Sunita Patel',
    'Warehouse Operations Supervisor',
    '+919876543211',
    ARRAY['medical', 'pharma', 'cold-chain'],
    'West',
    '{"start": "08:00", "end": "20:00", "timezone": "Asia/Kolkata"}'::jsonb,
    2,
    'en-IN',
    '2026-09-01T10:00:00Z'
),
(
    'ct-vikram-shah',
    'org-metro',
    'Vikram Shah',
    'VP Supply Chain',
    '+919876543212',
    ARRAY['medical', 'pharma'],
    'West',
    '{"start": "09:00", "end": "18:00", "timezone": "Asia/Kolkata"}'::jsonb,
    3,
    'en-IN',
    '2026-09-01T10:00:00Z'
)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role;

-- 3. Hero Order: CR-1006 / ORD-482 (Medical Supplies Replenishment)
INSERT INTO public.orders (
    id, reference, trace_id, buyer_id, seller_id, status, urgency, required_by,
    created_at, current_rung, max_rungs, outcome, operator_minutes_saved, scenario_id
) VALUES (
    'CR-1006',
    'ORD-482',
    'tr-hero-482',
    'org-northgate',
    'org-metro',
    'PARTIALLY_CONFIRMED',
    'URGENT',
    NOW() + INTERVAL '4 hours',
    NOW() - INTERVAL '30 minutes',
    1,
    3,
    'Confirmed 120 cases today; remaining 80 cases promised tomorrow morning (14 Sep 09:00 IST)',
    14,
    'partial-stock'
) ON CONFLICT (id) DO NOTHING;

-- Order Item for CR-1006
INSERT INTO public.order_items (
    order_id, sku, description, unit, requested_quantity, confirmed_quantity, remaining_quantity, unit_price, currency
) VALUES (
    'CR-1006',
    'MED-TS-CASE',
    'Temperature-sensitive medical supplies',
    'cases',
    200,
    120,
    80,
    1850.00,
    'INR'
) ON CONFLICT DO NOTHING;

-- Trigger for CR-1006
INSERT INTO public.triggers (order_id, type, summary, received_at) VALUES (
    'CR-1006',
    'INVENTORY',
    'Inventory fell below safety stock (available: 40 cases, target reorder: 240 cases)',
    NOW() - INTERVAL '30 minutes'
) ON CONFLICT DO NOTHING;

-- Follow-up for CR-1006
INSERT INTO public.follow_ups (id, order_id, kind, due_at, contact_id, note, status) VALUES (
    'CR-1006-rem-80',
    'CR-1006',
    'REMAINING_QUANTITY',
    NOW() + INTERVAL '14 hours',
    'ct-rajesh-iyer',
    'Confirm remaining 80 cases dispatched from Metro Supply Co.',
    'SCHEDULED'
) ON CONFLICT (id) DO NOTHING;
