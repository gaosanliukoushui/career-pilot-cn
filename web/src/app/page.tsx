import { doctorState } from "@/lib/career-ops";
import { CareerPilotCnFirstRun } from "@/components/cn/cn-first-run";
import { TodayDashboard } from "@/components/home/today-dashboard";

export const dynamic = "force-dynamic";

export default function Home() {
  const { onboardingNeeded } = doctorState();
  return onboardingNeeded ? <CareerPilotCnFirstRun /> : <TodayDashboard />;
}
