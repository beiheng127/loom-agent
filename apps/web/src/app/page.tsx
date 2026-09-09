import { LoomShell } from "@/components/LoomShell";
import { ConfirmProvider } from "@/lib/confirm";

export default function HomePage() {
  return (
    <ConfirmProvider>
      <LoomShell />
    </ConfirmProvider>
  );
}
