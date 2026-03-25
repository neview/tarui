import { ShineBorder } from "@/components/ui/shine-border";
import { WxRibaoForm, WxRibaoFormData } from "../KuaishouForm";

interface KuaishouCardProps {
  onSubmit?: (data: WxRibaoFormData) => void;
  onCancel?: () => void;
  loading?: boolean;
}

export function KuaishouCard({ onSubmit, onCancel, loading }: KuaishouCardProps) {
  return (
    <div className="relative isolate w-full overflow-hidden rounded-xl">
      <ShineBorder
        borderWidth={2}
        duration={14}
        shineColor={["#f7d047", "#50c9ff", "#f7d047"]}
        className="rounded-xl"
      />
      <div className="relative z-10 rounded-xl bg-card px-6 py-5">
        <div className="border-b border-border pb-4 mb-4">
          <h2 className="text-base font-medium leading-snug text-foreground mb-1">
            微信日报
          </h2>
          <p className="text-sm text-muted-foreground">
            获取指定日期范围内的微信文档日报
          </p>
        </div>
        <WxRibaoForm onSubmit={onSubmit} onCancel={onCancel} loading={loading} />
      </div>
    </div>
  );
}
