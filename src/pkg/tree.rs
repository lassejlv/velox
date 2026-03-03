use std::collections::{BTreeMap, HashMap};

use super::InstalledPackage;

pub(super) fn print_dependency_tree(
    roots: &BTreeMap<String, String>,
    installed: &HashMap<String, InstalledPackage>,
) {
    println!("\nDependency tree:");
    let root_names: Vec<String> = roots.keys().cloned().collect();
    for (i, name) in root_names.iter().enumerate() {
        let last = i + 1 == root_names.len();
        let mut trail = vec![name.clone()];
        print_tree_node(name, "", last, installed, &mut trail);
    }
}

fn print_tree_node(
    name: &str,
    prefix: &str,
    is_last: bool,
    installed: &HashMap<String, InstalledPackage>,
    trail: &mut Vec<String>,
) {
    let connector = if is_last { "\\- " } else { "+- " };
    if let Some(pkg) = installed.get(name) {
        println!("{}{}{}@{}", prefix, connector, name, pkg.version);
        let next_prefix = if is_last {
            format!("{}   ", prefix)
        } else {
            format!("{}|  ", prefix)
        };

        let deps: Vec<String> = pkg.dependencies.keys().cloned().collect();
        for (i, dep) in deps.iter().enumerate() {
            let dep_last = i + 1 == deps.len();
            if trail.iter().any(|x| x == dep) {
                let cyc = if dep_last { "\\- " } else { "+- " };
                println!("{}{}{} (cycle)", next_prefix, cyc, dep);
                continue;
            }
            trail.push(dep.clone());
            print_tree_node(dep, &next_prefix, dep_last, installed, trail);
            trail.pop();
        }
    } else {
        println!("{}{}{} (missing)", prefix, connector, name);
    }
}
