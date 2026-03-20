import { Routes, Route } from "react-router-dom";

import "./App.css";
import "./globals.css";
import NavBar from "./components/NavBar/navBar";
import { LeftMenu } from "./components/LeftMenu/leftMenu";

// 导入页面组件
import Feiji from "./pages/Feiji";
import Kuaishou from "./pages/Kuaishou";
import Douyin from "./pages/Douyin";
import Weixin from "./pages/Weixin";
import QQ from "./pages/QQ";

function App() {
  return (
    <main>
      <NavBar />
      <div className="content_box">
        <div>
          <LeftMenu />
        </div>
        <div className="main_content relative overflow-hidden">
          <Routes>
            <Route path="/" element={<Feiji />} />
            <Route path="/feiji" element={<Feiji />} />
            <Route path="/kuaishou" element={<Kuaishou />} />
            <Route path="/douyin" element={<Douyin />} />
            <Route path="/weixin" element={<Weixin />} />
            <Route path="/qq" element={<QQ />} />
          </Routes>
        </div>
      </div>

    </main>
  );
}

export default App;
