import { VendorDetailView } from "@/components/ops/VendorDetailView";

export const metadata = { title: "Vendor Details — Market Buddy" };

export default async function VendorDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <VendorDetailView vendorId={id} />;
}
