import { MagicCard } from "@/components/ui/magic-card";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ReleaseForm, ReleaseFormData } from "../ReleaseForm";

interface ReleaseCardProps {
  onSubmit?: (data: ReleaseFormData) => void;
}

export function ReleaseCard({ onSubmit }: ReleaseCardProps) {
  return (
    <Card className="w-full max-w-sm border-none p-0 shadow-none">
      <MagicCard
        gradientColor="#D9D9D955"
        className="p-0"
      >
        <CardHeader className="border-border border-b p-4 [.border-b]:pb-4">
          <CardTitle>发布微信小程序版本</CardTitle>
          <CardDescription>
            填写版本信息并发布新版本
          </CardDescription>
        </CardHeader>
        <CardContent className="p-4">
          <ReleaseForm onSubmit={onSubmit} />
        </CardContent>
      </MagicCard>
    </Card>
  );
}
