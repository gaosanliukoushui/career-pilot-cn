"use client";

import { useEffect, useState } from "react";
import type { CareerPilotApplication } from "@/lib/cn-types";
import { ApplicationPanel } from "@/components/cn/application-panel";

export function ApplicationDetailLoader({ tracker }: { tracker: string }) {
  const [application, setApplication] = useState<CareerPilotApplication | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { void fetch(`/api/cn/applications/${tracker}`).then((response) => response.json().then((data) => ({ response, data }))).then(({ response, data }) => response.ok ? setApplication(data.application) : setError(data.error || "读取失败")); }, [tracker]);
  if (error) return <div className="p-8 text-brand-text">{error}</div>;
  if (!application) return <div className="p-8 text-muted">正在读取网申材料……</div>;
  return <div className="mx-auto max-w-6xl p-5 md:p-8"><ApplicationPanel initial={application} /></div>;
}

