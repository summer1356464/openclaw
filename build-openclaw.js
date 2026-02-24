#!/usr/bin/env node
// OpenClaw编译脚本
// 用于正确编译OpenClaw项目并重新安装

import { execSync } from "child_process";
import fs from "fs";
import path from "path";

function runCommand(command, cwd = process.cwd()) {
  console.log(`执行命令: ${command}`);
  try {
    const output = execSync(command, { cwd, encoding: "utf8", stdio: "inherit" });
    console.log("命令执行成功");
    return output;
  } catch (error) {
    console.error(`命令执行失败: ${error.message}`);
    process.exit(1);
  }
}

function main() {
  console.log("=== OpenClaw 编译脚本 ===");
  console.log("执行时间:", new Date().toISOString());

  const projectDir = path.resolve("C:\\Users\\Acer\\src\\openclaw");

  if (!fs.existsSync(projectDir)) {
    console.error("项目目录不存在:", projectDir);
    process.exit(1);
  }

  console.log("项目目录:", projectDir);

  // 步骤1: 使用tsdown编译项目
  console.log("\n1. 使用tsdown编译项目...");
  runCommand("npx tsdown", projectDir);

  // 步骤2: 重新安装OpenClaw
  console.log("\n2. 重新安装OpenClaw...");
  runCommand("npm install -g .", projectDir);

  // 步骤3: 重启Gateway服务
  console.log("\n3. 重启Gateway服务...");
  runCommand("openclaw gateway stop && openclaw gateway start", projectDir);

  // 步骤4: 验证安装状态
  console.log("\n4. 验证安装状态...");
  runCommand("openclaw --version", projectDir);
  runCommand("openclaw gateway status", projectDir);

  console.log("\n=== 编译完成 ===");
  console.log("OpenClaw 已成功编译并重新安装");
  console.log("Gateway 服务已重启");
  console.log("现在可以测试百度搜索API速率限制回退机制");
}

main();
