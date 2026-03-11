import styles from "./index.module.scss";
import guantou from "../../assets/guantou.png";
import jitui from "../../assets/jitui.png";
import lajiao from "../../assets/lajiao.png";
import qiezi from "../../assets/qiezi.png";
import tangguo from "../../assets/tangguo.png";
import { useEffect, useRef, useState } from "react";
export function LeftMenu() {
  const parentRef = useRef(null);
  const imgList = [guantou, jitui, lajiao, qiezi, tangguo];
  const [style, setStyle] = useState({ transform: "translateY(0px)" });

  useEffect(() => {
    console.log("parentRef", parentRef.current);
    const activeEl = parentRef.current.querySelector(`.img:nth-child(1)`);
    console.log("activeEl", activeEl);
  }, []);

  const handleClick = (e) => {
    const parentRect = parentRef.current.getBoundingClientRect();
    const targetRect = e.currentTarget.getBoundingClientRect();
    setStyle({
      transform: `translateY(${targetRect.top - parentRect.top - 12.5}px)`,
    });
  };
  return (
    <div className={styles.left_menu} ref={parentRef}>
      {imgList.map((img, index) => (
        <img key={index} src={img} alt="" onClick={handleClick} />
      ))}
      <div className={styles.left_menu_item} style={style}></div>
    </div>
  );
}
