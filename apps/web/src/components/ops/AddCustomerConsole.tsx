"use client";

/**
 * Add Vendor Console — Wholesaler Contact Management
 *
 * Allows wholesalers to register new vendors into their system.
 * Vendors are the business clients/buyers who purchase items from the wholesaler.
 *
 * Form fields:
 *  - Name (Full name) - Required
 *  - Mobile No. - Required
 *  - Region - Required
 *  - Workplace Location - Required
 *  - Living Location - Optional
 *  - Shop Name - Optional
 */

import { useState } from "react";
import { z } from "zod";
import { UserPlus, Building2, CheckCircle2, ShieldCheck } from "lucide-react";
import type { Contact } from "@/lib/contracts/domain";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { apiPost } from "@/lib/api";

const VendorFormSchema = z.object({
  name: z.string().trim().min(2, "Full name is required (at least 2 characters)"),
  mobileNo: z
    .string()
    .trim()
    .regex(/^[+0-9\s-]{10,15}$/, "Valid mobile number required (10-15 digits)"),
  region: z.string().trim().min(2, "Region is required"),
  workplaceLocation: z.string().trim().min(3, "Workplace location is required"),
  livingLocation: z.string().trim().optional(),
  shopName: z.string().trim().optional(),
});

type FormState = {
  name: string;
  mobileNo: string;
  region: string;
  workplaceLocation: string;
  livingLocation: string;
  shopName: string;
};

type FieldErrors = Partial<Record<keyof FormState, string>>;

const INITIAL_FORM: FormState = {
  name: "",
  mobileNo: "",
  region: "",
  workplaceLocation: "",
  livingLocation: "",
  shopName: "",
};

function Field({
  id,
  label,
  required,
  error,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="micro flex items-center justify-between">
        <span>
          {label} {required && <span className="text-state-critical">*</span>}
        </span>
        {!required && <span className="text-[10px] text-ink-faint font-normal">(Optional)</span>}
      </label>
      {children}
      {error && (
        <p id={`${id}-error`} className="text-xs text-state-critical">
          {error}
        </p>
      )}
    </div>
  );
}

const INPUT =
  "h-11 w-full rounded-md border border-line-strong bg-elevated px-3.5 text-sm text-ink " +
  "placeholder:text-ink-faint focus:border-lilac focus:outline-none aria-[invalid=true]:border-state-critical";

export function AddCustomerConsole() {
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastAdded, setLastAdded] = useState<Contact | null>(null);

  const update = (key: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((f) => ({ ...f, [key]: e.target.value }));
    setFieldErrors((errs) => ({ ...errs, [key]: undefined }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = VendorFormSchema.safeParse(form);
    if (!parsed.success) {
      const errs: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof FormState;
        errs[key] ??= issue.message;
      }
      setFieldErrors(errs);
      return;
    }

    setSubmitting(true);
    setError(null);

    apiPost<{ success: boolean; contact: Contact }>("/api/v1/contacts", {
      ...parsed.data,
      role: "Vendor",
    })
      .then((res) => {
        setLastAdded(res.contact);
        setForm(INITIAL_FORM);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to add vendor");
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  return (
    <div className="flex flex-col gap-6 p-5 sm:p-8 max-w-4xl mx-auto w-full">
      <header className="flex flex-col gap-2">
        <p className="eyebrow flex items-center gap-1.5 text-lilac">
          <Building2 className="h-3.5 w-3.5" />
          Wholesaler Portal
        </p>
        <h1 className="display text-display-s text-ink">
          Add new <em>vendor</em>
        </h1>
        <p className="max-w-[60ch] text-sm text-ink-dim">
          Register a vendor who purchases goods from your wholesale business. Registered vendors can receive automated voice coordination calls, stock updates, and delivery confirmations.
        </p>
      </header>

      {lastAdded && (
        <div className="flex items-center justify-between rounded-lg border border-state-success/40 bg-state-success/10 px-5 py-4 text-ink">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-state-success" />
            <div>
              <p className="font-semibold text-sm">
                Successfully added vendor &quot;{lastAdded.name}&quot;
              </p>
              <p className="text-xs text-ink-dim mt-0.5">
                {lastAdded.shopName ? `${lastAdded.shopName} · ` : ""}
                {lastAdded.region} · {lastAdded.phoneE164}
              </p>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setLastAdded(null)}>
            Dismiss
          </Button>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-state-critical/40 bg-state-critical/8 px-5 py-3 text-sm text-state-critical">
          {error}
        </div>
      )}

      <Panel label="Vendor Registration" bodyClassName="p-6">
        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          <div className="grid gap-5 sm:grid-cols-2">
            <Field id="name" label="Full Name" required error={fieldErrors.name}>
              <input
                id="name"
                placeholder="e.g. Ramesh Sharma"
                value={form.name}
                onChange={update("name")}
                aria-invalid={Boolean(fieldErrors.name)}
                className={INPUT}
                autoComplete="off"
              />
            </Field>

            <Field id="mobileNo" label="Mobile Number" required error={fieldErrors.mobileNo}>
              <input
                id="mobileNo"
                type="tel"
                placeholder="e.g. +91 9876543210"
                value={form.mobileNo}
                onChange={update("mobileNo")}
                aria-invalid={Boolean(fieldErrors.mobileNo)}
                className={INPUT}
                autoComplete="off"
              />
            </Field>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field id="region" label="Region / Territory" required error={fieldErrors.region}>
              <input
                id="region"
                placeholder="e.g. Mumbai West, Delhi NCR"
                value={form.region}
                onChange={update("region")}
                aria-invalid={Boolean(fieldErrors.region)}
                className={INPUT}
                autoComplete="off"
              />
            </Field>

            <Field id="shopName" label="Shop / Business Name" error={fieldErrors.shopName}>
              <input
                id="shopName"
                placeholder="e.g. Sharma Traders & Sons"
                value={form.shopName}
                onChange={update("shopName")}
                aria-invalid={Boolean(fieldErrors.shopName)}
                className={INPUT}
                autoComplete="off"
              />
            </Field>
          </div>

          <Field id="workplaceLocation" label="Workplace Location (Address/Zone)" required error={fieldErrors.workplaceLocation}>
            <input
              id="workplaceLocation"
              placeholder="e.g. Gala 42, MIDC Industrial Area, Phase II"
              value={form.workplaceLocation}
              onChange={update("workplaceLocation")}
              aria-invalid={Boolean(fieldErrors.workplaceLocation)}
              className={INPUT}
              autoComplete="off"
            />
          </Field>

          <Field id="livingLocation" label="Living Location (Residential)" error={fieldErrors.livingLocation}>
            <input
              id="livingLocation"
              placeholder="e.g. Flat 302, Sunshine Heights, Andheri East"
              value={form.livingLocation}
              onChange={update("livingLocation")}
              aria-invalid={Boolean(fieldErrors.livingLocation)}
              className={INPUT}
              autoComplete="off"
            />
          </Field>

          <div className="pt-4 flex items-center justify-between border-t border-line">
            <span className="text-xs text-ink-dim flex items-center gap-1.5">
              <ShieldCheck className="h-4 w-4 text-state-success" />
              Implicit consent registered for wholesale calling.
            </span>
            <Button variant="primary" size="lg" type="submit" disabled={submitting}>
              <UserPlus className="h-4 w-4" />
              {submitting ? "Adding Vendor…" : "Add New Vendor"}
            </Button>
          </div>
        </form>
      </Panel>
    </div>
  );
}
