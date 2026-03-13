import styles from "./index.module.scss";
import feji from "../../assets/1(1).png";
import feji2 from "../../assets/1(2).png";
import kuaishou from "../../assets/1(3).png";
import kuaishou2 from "../../assets/1(4).png";
import douyin from "../../assets/1(5).png";
import douyin2 from "../../assets/1(6).png";
import weixin from "../../assets/1(7).png";
import weixin2 from "../../assets/1(8).png";
import qq from "../../assets/1(9).png";
import qq2 from "../../assets/1(10).png";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";

interface MenuItem {
  white: string;
  black: string;
  path: string;
}

export function LeftMenu() {
  const navigate = useNavigate();
  const location = useLocation();
  const parentRef = useRef<HTMLDivElement>(null);
  const imgList: MenuItem[] = [
    { white: feji, black: feji2, path: "/feiji" },
    { white: kuaishou, black: kuaishou2, path: "/kuaishou" },
    { white: douyin, black: douyin2, path: "/douyin" },
    { white: weixin, black: weixin2, path: "/weixin" },
    { white: qq, black: qq2, path: "/qq" },
  ];
  
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [style, setStyle] = useState({ transform: "translateY(0px)" });
  const [animatingIndex, setAnimatingIndex] = useState<number | null>(null);

  // 根据当前路由路径确定选中的菜单项
  useEffect(() => {
    const currentIndex = imgList.findIndex(item => item.path === location.pathname);
    if (currentIndex !== -1 && currentIndex !== selectedIndex) {
      setSelectedIndex(currentIndex);
      // 更新指示器位置
      if (parentRef.current) {
        const parentRect = parentRef.current.getBoundingClientRect();
        const items = parentRef.current.querySelectorAll('img');
        const targetItem = items[currentIndex] as HTMLImageElement;
        if (targetItem) {
          const targetRect = targetItem.getBoundingClientRect();
          setStyle({
            transform: `translateY(${targetRect.top - parentRect.top - 8}px)`,
          });
        }
      }
    }
  }, [location.pathname]);

  useEffect(() => {
    if (!parentRef.current) return;
    const parentRect = parentRef.current.getBoundingClientRect();
    const firstItem = parentRef.current.querySelector(`img:nth-child(1)`) as HTMLImageElement;
    if (!firstItem) return;
    const firstItemRect = firstItem.getBoundingClientRect();
    setStyle({
      transform: `translateY(${firstItemRect.top - parentRect.top - 8}px)`,
    });
  }, []);

  const handleClick = (e: React.MouseEvent<HTMLImageElement>, index: number) => {
    if (!parentRef.current) return;
    const parentRect = parentRef.current.getBoundingClientRect();
    const targetRect = e.currentTarget.getBoundingClientRect();
    setStyle({
      transform: `translateY(${targetRect.top - parentRect.top - 8}px)`,
    });
    setSelectedIndex(index);
    
    // 触发动画
    setAnimatingIndex(index);
    setTimeout(() => {
      setAnimatingIndex(null);
    }, 300);

    // 导航到对应路由
    navigate(imgList[index].path);
  };

  return (
    <div className={styles.left_menu} ref={parentRef}>
      {imgList.map((item, index) => (
        <img
          key={index}
          src={selectedIndex === index ? item.white : item.black}
          alt=""
          onClick={(e) => handleClick(e, index)}
          className={animatingIndex === index ? styles.scaleAnim : ""}
        />
      ))}
      <div className={styles.left_menu_item} style={style}></div>
    </div>
  );
}
