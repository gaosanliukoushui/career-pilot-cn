import { CvEditor } from "@/components/cv-editor";
import { ResumeWorkspace } from "@/components/cn/resume-workspace";

export const dynamic = "force-dynamic";

export default function CvPage() {
  return <><CvEditor /><ResumeWorkspace /></>;
}
