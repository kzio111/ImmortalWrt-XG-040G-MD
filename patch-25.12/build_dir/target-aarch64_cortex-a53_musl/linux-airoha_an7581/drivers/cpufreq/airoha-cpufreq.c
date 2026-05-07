// SPDX-License-Identifier: GPL-2.0

#include <linux/bitfield.h>
#include <linux/cpufreq.h>
#include <linux/module.h>
#include <linux/platform_device.h>
#include <linux/pm_runtime.h>
#include <linux/slab.h>
#include <linux/io.h>      /* 修正 ioremap, readl, writel */
#include <linux/delay.h>   /* 修正 udelay */
#include <linux/pm_opp.h>  /* 修正 struct dev_pm_opp */

#include "cpufreq-dt.h"

#define REG_SCU_BASE      0x1fa20000
#define REG_MCUCFG_BASE   0x1efbe000

#define CLK_MUX           0x01e0
#define PLL_LOCK_CTRL     0x0268
#define ARMPLL_PCW        0x02b4
#define ARMPLL_CHG        0x02b8
#define MCU_CFG_U         0x0640
#define MCU_CFG_S         0x07c0

struct airoha_cpufreq_priv {
	int opp_token;
	struct device **virt_devs;
	struct platform_device *cpufreq_dt;
};

static struct platform_device *cpufreq_pdev;

/* NOP function to disable OPP from setting clock */
static int airoha_cpufreq_config_clks_nop(struct device *dev,
					  struct opp_table *opp_table,
					  struct dev_pm_opp *old_opp,
					  struct dev_pm_opp *opp,
					  void *data, bool scaling_down)
{
	unsigned long rate = dev_pm_opp_get_freq(opp);
    	u32 target_mhz = rate / 1000000;
    	u32 pcw_int, posdiv, val;
    	void __iomem *scu, *mcu;

    	/* 計算 PCW 與 POSDIV */
    	if (target_mhz < 1000) {
        	posdiv = 1;
        	pcw_int = target_mhz / 25;
    	} else {
        	posdiv = 0;
        	pcw_int = target_mhz / 50;
    	}

    	scu = ioremap(REG_SCU_BASE, 0x1000);
    	mcu = ioremap(REG_MCUCFG_BASE, 0x1000);
    	if (!scu || !mcu) return -ENOMEM;

    	/* Step 1 & 2: 切換到 PLL2 備用路徑 */
    	writel(readl(scu + CLK_MUX) | 0x4, scu + CLK_MUX);
    	writel((readl(mcu + MCU_CFG_U) & 0xFFFFFFE0) | 0x12, mcu + MCU_CFG_U);
    	writel((readl(mcu + MCU_CFG_S) & 0xFFFFF9FF) | (3 << 9), mcu + MCU_CFG_S);

    	/* Step 3 & 4: 解鎖並修改 PCW */
    	writel((readl(scu + PLL_LOCK_CTRL) & 0xFFFFFF00) | 0x12, scu + PLL_LOCK_CTRL);
    	writel((readl(scu + ARMPLL_PCW) & 0x00FFFFFF) | (pcw_int << 24), scu + ARMPLL_PCW);

    	/* Step 5: 切換 POSDIV 並觸發 CHG bit (Toggle 邏輯) */
    	val = readl(scu + ARMPLL_CHG);
    	if (val & 0x1)
        	writel((val & 0xFFFFFF8E) | (posdiv << 4), scu + ARMPLL_CHG);
    	else
        	writel((val & 0xFFFFFF8E) | (posdiv << 4) | 0x1, scu + ARMPLL_CHG);

    	/* Step 6: 等待 PLL 穩定 */
    	udelay(200); 

    	/* Step 7 & 8: 切換回 ARMPLL 主路徑 */
    	writel(readl(scu + CLK_MUX) | 0x1, scu + CLK_MUX);
    	writel((readl(mcu + MCU_CFG_U) & 0xFFFFFFE0) | 0x12, mcu + MCU_CFG_U);
    	writel((readl(mcu + MCU_CFG_S) & 0xFFFFF9FF) | (1 << 9), mcu + MCU_CFG_S);

    	/* Step 9 & 10: 清理路徑並重新鎖定寄存器 */
    	writel(readl(scu + CLK_MUX) & 0xFFFFFFFB, scu + CLK_MUX);
    	writel(readl(scu + PLL_LOCK_CTRL) & 0xFFFFFF00, scu + PLL_LOCK_CTRL);

    	iounmap(scu);
    	iounmap(mcu);

	return 0;
}

static const char * const airoha_cpufreq_clk_names[] = { "cpu", NULL };
static const char * const airoha_cpufreq_pd_names[] = { "perf", NULL };

static int airoha_cpufreq_probe(struct platform_device *pdev)
{
	struct platform_device *cpufreq_dt;
	struct airoha_cpufreq_priv *priv;
	struct device *dev = &pdev->dev;
	struct device **virt_devs = NULL;
	struct device *cpu_dev;
	struct dev_pm_opp_config config = {
		.clk_names = airoha_cpufreq_clk_names,
		.config_clks = airoha_cpufreq_config_clks_nop,
		.genpd_names = airoha_cpufreq_pd_names,
		.virt_devs = &virt_devs,
	};
	int ret;

	/* CPUs refer to the same OPP table */
	cpu_dev = get_cpu_device(0);
	if (!cpu_dev)
		return -ENODEV;

	priv = devm_kzalloc(dev, sizeof(*priv), GFP_KERNEL);
	if (!priv)
		return -ENOMEM;

	/* Set OPP table conf with NOP config_clks */
	priv->opp_token = dev_pm_opp_set_config(cpu_dev, &config);
	if (priv->opp_token < 0)
		return dev_err_probe(dev, priv->opp_token, "Failed to set OPP config\n");

	/* Set Attached PM for OPP ACTIVE */
	if (virt_devs) {
		const char * const *name = airoha_cpufreq_pd_names;
		int i, j;

		for (i = 0; *name; i++, name++) {
			ret = pm_runtime_resume_and_get(virt_devs[i]);
			if (ret) {
				dev_err(cpu_dev, "failed to resume %s: %d\n",
					*name, ret);

				/* Rollback previous PM runtime calls */
				name = config.genpd_names;
				for (j = 0; *name && j < i; j++, name++)
					pm_runtime_put(virt_devs[j]);

				goto err_register_cpufreq;
			}
		}
		priv->virt_devs = virt_devs;
	}

	cpufreq_dt = platform_device_register_simple("cpufreq-dt", -1, NULL, 0);
	ret = PTR_ERR_OR_ZERO(cpufreq_dt);
	if (ret) {
		dev_err(dev, "failed to create cpufreq-dt device: %d\n", ret);
		goto err_register_cpufreq;
	}

	priv->cpufreq_dt = cpufreq_dt;
	platform_set_drvdata(pdev, priv);

	return 0;

err_register_cpufreq:
	dev_pm_opp_clear_config(priv->opp_token);

	return ret;
}

static void airoha_cpufreq_remove(struct platform_device *pdev)
{
	struct airoha_cpufreq_priv *priv = platform_get_drvdata(pdev);

	platform_device_unregister(priv->cpufreq_dt);

	dev_pm_opp_clear_config(priv->opp_token);

	if (priv->virt_devs) {
		const char * const *name = airoha_cpufreq_pd_names;
		int i;

		for (i = 0; *name; i++, name++)
			pm_runtime_put(priv->virt_devs[i]);
	}
}

static struct platform_driver airoha_cpufreq_driver = {
	.probe = airoha_cpufreq_probe,
	.remove_new = airoha_cpufreq_remove,
	.driver = {
		.name = "airoha-cpufreq",
	},
};

static const struct of_device_id airoha_cpufreq_match_list[] __initconst = {
	{ .compatible = "airoha,an7583" },
	{ .compatible = "airoha,en7581" },
	{ .compatible = "airoha,an7581" },
	{},
};
MODULE_DEVICE_TABLE(of, airoha_cpufreq_match_list);

static int __init airoha_cpufreq_init(void)
{
	struct device_node *np = of_find_node_by_path("/");
	const struct of_device_id *match;
	int ret;

	if (!np)
		return -ENODEV;

	match = of_match_node(airoha_cpufreq_match_list, np);
	of_node_put(np);
	if (!match)
		return -ENODEV;

	ret = platform_driver_register(&airoha_cpufreq_driver);
	if (unlikely(ret < 0))
		return ret;

	cpufreq_pdev = platform_device_register_data(NULL, "airoha-cpufreq",
						     -1, match, sizeof(*match));
	ret = PTR_ERR_OR_ZERO(cpufreq_pdev);
	if (ret)
		platform_driver_unregister(&airoha_cpufreq_driver);

	return ret;
}
module_init(airoha_cpufreq_init);

static void __exit airoha_cpufreq_exit(void)
{
	platform_device_unregister(cpufreq_pdev);
	platform_driver_unregister(&airoha_cpufreq_driver);
}
module_exit(airoha_cpufreq_exit);

MODULE_AUTHOR("Christian Marangi <ansuelsmth@gmail.com>");
MODULE_DESCRIPTION("CPUfreq driver for Airoha SoCs");
MODULE_LICENSE("GPL");
