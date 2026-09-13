"use client";

/**
 * Wholesaler Profile Settings Console
 *
 * Allows wholesalers to view and edit their profile details:
 *  - Full Name
 *  - Email Address
 *  - Mobile Number
 *  - Age
 *  - Location / Address
 *  - Wholesaler Business Name
 */

import { useState, useEffect } from "react";
import {
  User,
  Mail,
  Phone,
  MapPin,
  Building2,
  Calendar,
  CheckCircle2,
  Save,
  ShieldCheck,
} from "lucide-react";
import { useAuth } from "@/lib/auth/auth-context";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { apiPut } from "@/lib/api";

const INPUT =
  "h-11 w-full rounded-md border border-line-strong bg-elevated px-3.5 text-sm text-ink " +
  "placeholder:text-ink-faint focus:border-lilac focus:outline-none aria-[invalid=true]:border-state-critical";

export function WholesalerProfileSettings() {
  const { profile, updateProfile } = useAuth();

  const [fullName, setFullName] = useState(profile?.fullName || "Ramesh Northgate");
  const [email] = useState(profile?.email || "wholesaler@northgate.com");
  const [phone, setPhone] = useState(profile?.phone || "+91 9876543210");
  const [age, setAge] = useState(profile?.age?.toString() || "42");
  const [location, setLocation] = useState(profile?.location || "Mumbai West, MIDC Industrial Area, Phase II");
  const [wholesalerName, setWholesalerName] = useState(
    profile?.wholesalerName || "Northgate Wholesale Distributors Pvt Ltd"
  );

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (profile) {
      setFullName(profile.fullName || "");
      if (profile.phone) setPhone(profile.phone);
      if (profile.age) setAge(profile.age.toString());
      if (profile.location) setLocation(profile.location);
      if (profile.wholesalerName) setWholesalerName(profile.wholesalerName);
    }
  }, [profile]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fullName.trim() || !phone.trim() || !wholesalerName.trim()) {
      setError("Full Name, Mobile Number, and Wholesaler Business Name are required.");
      return;
    }

    setSaving(true);
    setError(null);
    setSaved(false);

    try {
      await updateProfile({
        fullName: fullName.trim(),
        phone: phone.trim(),
        age: age.trim(),
        location: location.trim(),
        wholesalerName: wholesalerName.trim(),
      });

      await apiPut("/api/v1/profile", {
        userId: profile?.id,
        fullName: fullName.trim(),
        phone: phone.trim(),
        age: age.trim(),
        location: location.trim(),
        wholesalerName: wholesalerName.trim(),
      }).catch(() => {});

      setSaved(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save profile");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 p-5 sm:p-8 max-w-4xl mx-auto w-full">
      <header className="flex flex-col gap-2">
        <p className="eyebrow flex items-center gap-1.5 text-lilac">
          <Building2 className="h-3.5 w-3.5" />
          Wholesaler Settings & Preferences
        </p>
        <h1 className="display text-display-s text-ink">
          Edit <em>Wholesaler Profile</em>
        </h1>
        <p className="max-w-[60ch] text-sm text-ink-dim">
          Update your personal details, contact mobile number, age, territory location, and wholesaler business name.
        </p>
      </header>

      {saved && (
        <div className="flex items-center justify-between rounded-lg border border-state-success/40 bg-state-success/10 px-5 py-4 text-ink">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-state-success" />
            <div>
              <p className="font-semibold text-sm">Profile updated successfully!</p>
              <p className="text-xs text-ink-dim mt-0.5">
                Your wholesaler details and business information have been saved.
              </p>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setSaved(false)}>
            Dismiss
          </Button>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-state-critical/40 bg-state-critical/8 px-5 py-3 text-sm text-state-critical">
          {error}
        </div>
      )}

      <Panel label="Account & Business Details" bodyClassName="p-6">
        <form onSubmit={handleSave} className="flex flex-col gap-6">
          <div className="grid gap-6 sm:grid-cols-2">
            {/* Wholesaler Business Name */}
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <label htmlFor="wholesalerName" className="micro text-ink font-semibold flex items-center gap-1">
                <Building2 className="h-3.5 w-3.5 text-lilac" />
                Wholesaler Business Name <span className="text-state-critical">*</span>
              </label>
              <input
                id="wholesalerName"
                value={wholesalerName}
                onChange={(e) => setWholesalerName(e.target.value)}
                placeholder="e.g. Northgate Wholesale Distributors Pvt Ltd"
                className={INPUT}
                required
              />
            </div>

            {/* Full Name */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="fullName" className="micro text-ink font-semibold flex items-center gap-1">
                <User className="h-3.5 w-3.5 text-lilac" />
                Full Name <span className="text-state-critical">*</span>
              </label>
              <input
                id="fullName"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="e.g. Ramesh Northgate"
                className={INPUT}
                required
              />
            </div>

            {/* Email Address */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="email" className="micro text-ink-dim flex items-center gap-1">
                <Mail className="h-3.5 w-3.5 text-ink-faint" />
                Email Address (Account ID)
              </label>
              <input
                id="email"
                value={email}
                disabled
                className={`${INPUT} opacity-60 cursor-not-allowed`}
              />
            </div>

            {/* Mobile Number */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="phone" className="micro text-ink font-semibold flex items-center gap-1">
                <Phone className="h-3.5 w-3.5 text-lilac" />
                Mobile Number <span className="text-state-critical">*</span>
              </label>
              <input
                id="phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="e.g. +91 9876543210"
                className={INPUT}
                required
              />
            </div>

            {/* Age */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="age" className="micro text-ink font-semibold flex items-center gap-1">
                <Calendar className="h-3.5 w-3.5 text-lilac" />
                Age
              </label>
              <input
                id="age"
                type="number"
                value={age}
                onChange={(e) => setAge(e.target.value)}
                placeholder="e.g. 42"
                className={INPUT}
              />
            </div>

            {/* Location / Address */}
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <label htmlFor="location" className="micro text-ink font-semibold flex items-center gap-1">
                <MapPin className="h-3.5 w-3.5 text-lilac" />
                Wholesaler Location / Territory Address <span className="text-state-critical">*</span>
              </label>
              <input
                id="location"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="e.g. Plot 42, MIDC Industrial Area, Phase II, Mumbai West"
                className={INPUT}
                required
              />
            </div>
          </div>

          <div className="pt-4 flex items-center justify-between border-t border-line">
            <span className="text-xs text-ink-dim flex items-center gap-1.5">
              <ShieldCheck className="h-4 w-4 text-state-success" />
              Verified Wholesaler Account Credentials
            </span>
            <Button variant="primary" size="lg" type="submit" disabled={saving}>
              <Save className="h-4 w-4" />
              {saving ? "Saving Changes…" : "Save Wholesaler Profile"}
            </Button>
          </div>
        </form>
      </Panel>
    </div>
  );
}
