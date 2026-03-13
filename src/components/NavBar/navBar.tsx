import henggang from "../../assets/henggang.png";
import quanping from "../../assets/quanping.png";
import shanchu from "../../assets/shanchu.png";
import logo from "../../assets/yezishu.png";
import avatar from "../../assets/icon.webp";
// import xiaoxi from "../../assets/xiaoxi.png";
import xiaoxi2 from "../../assets/xiaoxi2.png";
import { Window } from "@tauri-apps/api/window";
const appWindow = new Window("main");
import styles from "./index.module.scss";

export default function NavBar() {
  return (
    <div className={styles.nav_bar}>
      <img className={styles.logo} src={logo} alt="" />
      <div className={styles.nav_bar_avatar}>
        <img src={avatar} alt="" />
        <div className={styles.line}></div>
        <img className={styles.text_img} src={xiaoxi2} alt="" />
      </div>
      <div className={styles.drag_area} data-tauri-drag-region></div>
      <div className={styles.min_butt} onClick={() => appWindow.minimize()}>
        <img src={henggang} alt="" />
      </div>
      <div
        className={styles.max_butt}
        onClick={() => appWindow.toggleMaximize()}
      >
        <img src={quanping} alt="" />
      </div>
      <div className={styles.close_butt} onClick={() => appWindow.close()}>
        <img src={shanchu} alt="" />
      </div>
    </div>
  );
}
