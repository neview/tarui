import { MagicCard } from "@/components/ui/magic-card";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { LoginForm, FormData } from "@/components/LoginForm";

interface LoginCardProps {
  onSubmit?: (data: FormData) => void;
}

export function LoginCard({ onSubmit }: LoginCardProps) {
  return (
    <Card className="w-full max-w-sm border-none p-0 shadow-none">
      <MagicCard
        gradientColor="#D9D9D955"
        className="p-0"
      >
        <CardHeader className="border-border border-b p-4 [.border-b]:pb-4">
          <CardTitle>Login</CardTitle>
          <CardDescription>
            Enter your credentials to access your account
          </CardDescription>
        </CardHeader>
        <CardContent className="p-4">
          <LoginForm onSubmit={onSubmit} />
        </CardContent>
        <CardFooter className="border-border border-t p-4 [.border-t]:pt-4">
        </CardFooter>
      </MagicCard>
    </Card>
  );
}
