import type { Outcome } from "@design-studio/contracts";
export async function stopApplication(ports: {
  stopAdmissions(): void;
  stopJobs(timeoutMs: number): Promise<Outcome<{ active: number }>>;
  drainRequests(): Promise<void>;
  closeStore(): void;
  closeHost(): Promise<void>;
  closeBinding(): Promise<void>;
}): Promise<boolean> {
  ports.stopAdmissions();
  const jobs = await ports.stopJobs(10000);
  if (jobs.status !== "complete" || jobs.value.active !== 0) return false;
  await ports.drainRequests();
  ports.closeStore();
  await ports.closeHost();
  await ports.closeBinding();
  return true;
}
