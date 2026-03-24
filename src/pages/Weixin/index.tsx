import { Alert, useAlert } from "@/components/ui/alert";
import { Meteors } from "@/components/ui/meteors";

export default function Weixin() {
  const { alert, closeAlert } = useAlert();

  return (
    <div style={{ padding: "10px 10px 30px 10px" }} className="relative overflow-hidden">
      <Meteors number={20} />

      <Alert alert={alert} onClose={closeAlert} />
    </div>
  );
}
