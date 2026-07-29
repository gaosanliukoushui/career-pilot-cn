import { Send } from "lucide-react";
import { ApplyView } from "@/components/apply-view";
import { ApplyBackdropMount } from "@/components/apply/apply-backdrop-mount";

export const dynamic = "force-dynamic";

export default function ApplyPage() {
  return (
    <div className="relative min-h-screen">
      {/* full-viewport blurred form wallpaper (behind everything) */}
      <ApplyBackdropMount />
      <div className="relative z-10 mx-auto max-w-3xl px-6 py-8">
        <div className="flex items-center gap-3">
          <Send className="size-6 text-brand" />
          <h1 className="font-display text-2xl tracking-tight text-landing">填写申请</h1>
        </div>
        <p className="mt-1.5 max-w-xl text-sm text-muted">
          career-ops 会在本机读取真实申请表，并在这里清晰地重新呈现，同时根据你的简历预填答案。
          你需要核对每一项内容，然后系统会把内容填回真实表单；最终提交始终由你亲自完成。
        </p>
        <div className="mt-6">
          <ApplyView />
        </div>
      </div>
    </div>
  );
}
