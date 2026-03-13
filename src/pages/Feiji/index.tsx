import { LoginCard } from "@/components/LoginCard";
import { FormData } from "@/components/LoginForm";
import styles from "./index.module.scss";

export default function Feiji() {
  const handleFormSubmit = (data: FormData) => {
    console.log("表单提交:", data);
  };

  return (
    <div style={{ padding: "10px 10px 30px 10px" }} className={styles.feiji_page}>
      <LoginCard onSubmit={handleFormSubmit} />
    </div>
  );
}
