import henggang from "../../assets/henggang.png";
import quanping from "../../assets/quanping.png";
import shanchu from "../../assets/shanchu.png";
import shanchuDark from "../../assets/shanchu1.png";
import logo from "../../assets/yezishu.png";
import avatar from "../../assets/icon.webp";
import xiaoxi from "../../assets/xiaoxi.png";
import xiaoxi2 from "../../assets/xiaoxi2.png";
import henggangWhite from "../../assets/Minimize-2 (1).png";
import quanpingWhite from "../../assets/quanping2.png";
import { Window } from "@tauri-apps/api/window";
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { useEffect, useState } from "react";
const appWindow = new Window("main");
import styles from "./index.module.scss";

export default function NavBar() {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const checkDark = () => {
      setIsDark(document.documentElement.classList.contains("dark"));
    };
    checkDark();
    
    const observer = new MutationObserver(checkDark);
    observer.observe(document.documentElement, { 
      attributes: true, 
      attributeFilter: ['class'] 
    });
    
    return () => observer.disconnect();
  }, []);

  return (
    <div className={styles.nav_bar}>
      <img className={styles.logo} src={logo} alt="" />
      <div className={styles.nav_bar_avatar}>
        <img src={avatar} alt="" />
        <div className={styles.nav_line}></div>
        <img className={styles.text_img} src={isDark ? xiaoxi : xiaoxi2} alt="" />
      </div>
      <div className={styles.drag_area} data-tauri-drag-region></div>
      <div className={styles.theme_toggle}>
        <AnimatedThemeToggler />
      </div>
      <div className={styles.min_butt} onClick={() => appWindow.minimize()}>
        <img src={isDark ? henggangWhite : henggang} alt="" />
      </div>
      <div
        className={styles.max_butt}
        onClick={() => appWindow.toggleMaximize()}
      >
        <img src={isDark ? quanpingWhite : quanping} alt="" />
      </div>
      <div className={styles.close_butt} onClick={() => appWindow.close()}>
        <img src={isDark ? shanchuDark : shanchu} alt="" />
      </div>
    </div>
  );
}
